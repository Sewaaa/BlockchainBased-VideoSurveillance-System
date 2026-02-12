// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title SecurityCamera V3 - Signature Authentication
 * @dev Sistema con verifica firma digitale per autenticare telecamere
 * @custom:version 3.1
 */
contract SecurityCamera {
    
    struct PhotoRecord {
        bytes32 photoHash;
        uint256 timestamp;
        bytes32 cameraId;
        address cameraAddress;      // Address della telecamera (da firma)
        address relayAddress;       // Address che ha inviato la tx
        string location;
        string metadata;
    }
    
    struct CameraInfo {
        bytes32 cameraId;
        string macAddress;
        string eFuseId;
        address walletAddress;
        bool isAuthorized;
        uint256 registeredAt;
        uint256 photoCount;
        string location;
        string model;
    }
    
    // Archivio append-only dei record foto notarizzati.
    PhotoRecord[] public photoRecords;
    
    // Indici per ricerche veloci e protezione duplicati.
    mapping(bytes32 => bool) public photoExists;
    mapping(bytes32 => uint256) public hashToIndex;
    mapping(bytes32 => uint256[]) private photoIndicesByCameraId;
    
    // Registry camere e whitelist autorizzazioni.
    mapping(bytes32 => CameraInfo) public cameras;
    mapping(address => bytes32) public addressToCameraId;
    mapping(bytes32 => bool) public authorizedCameras;
    
    // Nonce per prevenire replay attacks
    mapping(address => uint256) public nonces;
    
    address public owner;
    bool public paused = false;
    
    uint256 public constant MAX_PHOTOS_PER_CAMERA = 1000000;
    uint256 public totalCameras;
    uint256 public totalAuthorizedCameras;
    
    event PhotoRecorded(
        bytes32 indexed photoHash,
        uint256 indexed timestamp,
        bytes32 indexed cameraId,
        address cameraAddress,
        address relayAddress,
        string location,
        uint256 recordId
    );
    
    event CameraRegistered(
        bytes32 indexed cameraId,
        address indexed walletAddress,
        string macAddress,
        string eFuseId
    );
    
    event CameraAuthorized(bytes32 indexed cameraId, address indexed walletAddress);
    event CameraRevoked(bytes32 indexed cameraId, address indexed walletAddress);
    event UnauthorizedAttempt(address indexed attemptedBy, bytes32 photoHash);
    event InvalidSignature(address indexed recovered, bytes32 photoHash);
    
    // Solo il proprietario puo eseguire operazioni amministrative.
    modifier onlyOwner() {
        require(msg. sender == owner, "Solo il proprietario");
        _;
    }
    
    // Circuit breaker: blocca operazioni scrittura quando paused = true.
    modifier whenNotPaused() {
        require(!paused, "Contratto in pausa");
        _;
    }
    
    constructor() {
        owner = msg.sender;
    }
    
    /**
     * @dev Genera ID univoco telecamera
     */
    function generateCameraId(
        string memory _macAddress,
        string memory _eFuseId
    ) public pure returns (bytes32) {
        return keccak256(abi. encodePacked(_macAddress, _eFuseId));
    }
    
    /**
     * @dev Registra telecamera
     */
    function registerCamera(
        string memory _macAddress,
        string memory _eFuseId,
        address _walletAddress,
        string memory _location,
        string memory _model
    ) public onlyOwner returns (bytes32) {
        require(_walletAddress != address(0), "Indirizzo non valido");
        require(bytes(_macAddress).length > 0, "MAC address richiesto");
        require(bytes(_eFuseId).length > 0, "eFuse ID richiesto");
        
        // cameraId deterministico da MAC + eFuse (allineato al calcolo lato gateway).
        bytes32 cameraId = generateCameraId(_macAddress, _eFuseId);
        
        require(cameras[cameraId].registeredAt == 0, "Telecamera gia registrata");
        require(addressToCameraId[_walletAddress] == bytes32(0), "Wallet gia in uso");
        
        cameras[cameraId] = CameraInfo({
            cameraId: cameraId,
            macAddress:  _macAddress,
            eFuseId: _eFuseId,
            walletAddress: _walletAddress,
            isAuthorized: false,
            registeredAt: block.timestamp,
            photoCount: 0,
            location: _location,
            model: _model
        });
        
        // Collega in modo univoco wallet camera <-> cameraId.
        addressToCameraId[_walletAddress] = cameraId;
        totalCameras++;
        
        emit CameraRegistered(cameraId, _walletAddress, _macAddress, _eFuseId);
        
        return cameraId;
    }
    
    /**
     * @dev Autorizza telecamera
     */
    function authorizeCamera(bytes32 _cameraId) public onlyOwner {
        require(cameras[_cameraId].registeredAt > 0, "Telecamera non registrata");
        require(! authorizedCameras[_cameraId], "Gia autorizzata");
        
        authorizedCameras[_cameraId] = true;
        cameras[_cameraId].isAuthorized = true;
        totalAuthorizedCameras++;
        
        emit CameraAuthorized(_cameraId, cameras[_cameraId].walletAddress);
    }
    
    /**
     * @dev Registra E autorizza
     */
    function registerAndAuthorizeCamera(
        string memory _macAddress,
        string memory _eFuseId,
        address _walletAddress,
        string memory _location,
        string memory _model
    ) public onlyOwner returns (bytes32) {
        bytes32 cameraId = registerCamera(_macAddress, _eFuseId, _walletAddress, _location, _model);
        authorizeCamera(cameraId);
        return cameraId;
    }
    
    /**
     * @dev Revoca autorizzazione
     */
    function revokeCamera(bytes32 _cameraId) public onlyOwner {
        require(authorizedCameras[_cameraId], "Non autorizzata");
        
        authorizedCameras[_cameraId] = false;
        cameras[_cameraId]. isAuthorized = false;
        totalAuthorizedCameras--;
        
        emit CameraRevoked(_cameraId, cameras[_cameraId].walletAddress);
    }
    
    /**
     * @dev Recupera indirizzo da firma
     * Verifica che il messaggio sia stato firmato dalla telecamera
     */
    function recoverSigner(
        bytes32 _photoHash,
        string memory _location,
        string memory _metadata,
        uint256 _nonce,
        bytes memory _signature
    ) public pure returns (address) {
        // Crea hash del messaggio (stesso formato usato dalla telecamera)
        bytes32 messageHash = keccak256(abi.encodePacked(
            _photoHash,
            _location,
            _metadata,
            _nonce
        ));
        
        // Aggiungi prefix Ethereum Signed Message
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            messageHash
        ));
        
        // Recupera indirizzo dal signature
        return recoverAddress(ethSignedMessageHash, _signature);
    }
    
    /**
     * @dev Recupera address da firma (ecrecover)
     */
    function recoverAddress(bytes32 _ethSignedMessageHash, bytes memory _signature) 
        internal 
        pure 
        returns (address) 
    {
        require(_signature.length == 65, "Lunghezza firma non valida");
        
        bytes32 r;
        bytes32 s;
        uint8 v;
        
        assembly {
            r := mload(add(_signature, 32))
            s := mload(add(_signature, 64))
            v := byte(0, mload(add(_signature, 96)))
        }
        
        // Aggiusta v se necessario
        if (v < 27) {
            v += 27;
        }
        
        require(v == 27 || v == 28, "Valore v non valido");
        
        return ecrecover(_ethSignedMessageHash, v, r, s);
    }
    
    /**
     * @dev Registra foto con verifica firma
     * La telecamera firma (photoHash + location + metadata + nonce)
     * Il contratto verifica la firma e controlla che provenga da camera autorizzata
     */
    function recordPhotoWithSignature(
        bytes32 _photoHash,
        string memory _location,
        string memory _metadata,
        bytes memory _signature
    ) public whenNotPaused returns (uint256) {
        require(_photoHash != bytes32(0), "Hash non valido");
        require(!photoExists[_photoHash], "Foto gia registrata");
        
        // Recupera indirizzo dalla firma
        address cameraAddress = recoverSigner(
            _photoHash,
            _location,
            _metadata,
            nonces[msg.sender],  // Usa nonce del relay
            _signature
        );
        
        // Verifica che la camera sia registrata
        bytes32 cameraId = addressToCameraId[cameraAddress];
        require(cameraId != bytes32(0), "Telecamera non registrata");
        
        // Verifica che la camera sia autorizzata
        require(authorizedCameras[cameraId], "Telecamera non autorizzata");
        
        // Verifica limite foto
        require(cameras[cameraId].photoCount < MAX_PHOTOS_PER_CAMERA, "Limite raggiunto");
        
        // Incrementa nonce del relay (msg.sender) per prevenire replay attacks
        nonces[msg.sender]++;
        
        // Crea record
        PhotoRecord memory newRecord = PhotoRecord({
            photoHash: _photoHash,
            timestamp: block.timestamp,
            cameraId: cameraId,
            cameraAddress: cameraAddress,     // Address della telecamera (da firma)
            relayAddress: msg.sender,         // Address del relay/FireFly
            location: _location,
            metadata: _metadata
        });
        
        photoRecords. push(newRecord);
        uint256 recordId = photoRecords.length - 1;
        
        photoExists[_photoHash] = true;
        hashToIndex[_photoHash] = recordId;
        photoIndicesByCameraId[cameraId].push(recordId);
        cameras[cameraId].photoCount++;
        
        emit PhotoRecorded(
            _photoHash,
            block.timestamp,
            cameraId,
            cameraAddress,
            msg.sender,
            _location,
            recordId
        );
        
        return recordId;
    }
    
    /**
     * @dev Verifica foto
     */
    function verifyPhoto(bytes32 _photoHash) public view returns (
        bool exists,
        uint256 timestamp,
        bytes32 cameraId,
        address cameraAddress,
        address relayAddress,
        string memory cameraModel,
        string memory location,
        string memory metadata
    ) {
        if (! photoExists[_photoHash]) {
            return (false, 0, bytes32(0), address(0), address(0), "", "", "");
        }
        
        uint256 index = hashToIndex[_photoHash];
        PhotoRecord memory record = photoRecords[index];
        CameraInfo memory camera = cameras[record.cameraId];
        
        return (
            true,
            record.timestamp,
            record.cameraId,
            record.cameraAddress,
            record.relayAddress,
            camera.model,
            record.location,
            record.metadata
        );
    }
    
    /**
     * @dev Ottieni nonce corrente di una camera (per firmare)
     */
    // Restituisce il nonce dell'indirizzo passato.
    // Nel flusso attuale viene usato il nonce del relay.
    function getNonce(address _cameraAddress) public view returns (uint256) {
        return nonces[_cameraAddress];
    }
    
    function getCameraInfo(bytes32 _cameraId) public view returns (CameraInfo memory) {
        require(cameras[_cameraId].registeredAt > 0, "Telecamera non esistente");
        return cameras[_cameraId];
    }
    
    function getCameraInfoByAddress(address _walletAddress) public view returns (CameraInfo memory) {
        bytes32 cameraId = addressToCameraId[_walletAddress];
        require(cameraId != bytes32(0), "Nessuna telecamera associata");
        return cameras[cameraId];
    }
    
    function getPhotosByCameraId(bytes32 _cameraId) public view returns (uint256[] memory) {
        return photoIndicesByCameraId[_cameraId];
    }
    
    function getTotalPhotos() public view returns (uint256) {
        return photoRecords.length;
    }
    
    function getPhotoByIndex(uint256 _index) public view returns (
        bytes32 photoHash,
        uint256 timestamp,
        bytes32 cameraId,
        address cameraAddress,
        address relayAddress,
        string memory location,
        string memory metadata
    ) {
        require(_index < photoRecords.length, "Indice non valido");
        PhotoRecord memory record = photoRecords[_index];
        return (
            record.photoHash,
            record.timestamp,
            record. cameraId,
            record. cameraAddress,
            record. relayAddress,
            record. location,
            record.metadata
        );
    }
    
    // Circuit breaker amministrativo.
    function setPaused(bool _paused) public onlyOwner {
        paused = _paused;
    }
    
    // Trasferisce ownership amministrativa.
    function transferOwnership(address _newOwner) public onlyOwner {
        require(_newOwner != address(0), "Indirizzo non valido");
        owner = _newOwner;
    }
}
