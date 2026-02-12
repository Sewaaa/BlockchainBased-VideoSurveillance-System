int pirPin = 2;
int pirState = LOW;

void setup() {
  pinMode(pirPin, INPUT);      // se serve metti INPUT_PULLUP/INPUT_PULLDOWN
  Serial.begin(9600);
  Serial.println("PIR pronto");
}

void loop() {
  int val = digitalRead(pirPin);

  if (val == HIGH && pirState == LOW) {
    pirState = HIGH;
    Serial.println("MOTION");   // <-- il Go leggerà questa riga
  } else if (val == LOW && pirState == HIGH) {
    pirState = LOW;
  }

  delay(50);  // piccolo debounce
}
