#include <AccelStepper.h>

// Define step and direction pins (using a driver like TB6600 or DM542)
const int stepPin = 6;
const int dirPin = 5;

// Create an instance in driver mode (1)
AccelStepper stepper(AccelStepper::DRIVER, stepPin, dirPin);

// How far to rotate on each trigger, and how long to wait before returning.
// The server only ever sends one command ("ROTATE"); all timing for the
// return trip lives here so it survives even if the server restarts.
//
// ROTATE_STEPS is in driver microsteps, not motor degrees or full steps.
// Driver is set to microstep 8 => 1600 pulses/rev, so:
//   ROTATE_STEPS = (desired_angle_degrees / 360) * 1600
// e.g. 67 steps for ~15 degrees, 89 for ~20 degrees, 133 for ~30 degrees.
// Recompute this if the driver's microstep DIP switches change.
const long ROTATE_STEPS = 178; // ~40 degree nudge
const unsigned long RETURN_DELAY_MS = 5UL * 60UL * 1000UL; // must match DISCHARGE_DURATION_MS in server.js

enum MotorState { IDLE, MOVING_OUT, WAITING, MOVING_BACK };
MotorState motorState = IDLE;
unsigned long waitStartMillis = 0;

String serialBuffer = "";

void setup() {
  Serial.begin(9600);

  stepper.setMaxSpeed(150.0);
  stepper.setAcceleration(100.0); // required for run()/moveTo() to move at all - without this, acceleration defaults to 0 and computed speed stays 0
}

void loop() {
  readSerialCommands();

  switch (motorState) {
    case MOVING_OUT:
      stepper.run();
      if (stepper.distanceToGo() == 0) {
        motorState = WAITING;
        waitStartMillis = millis();
        Serial.println("Motor reached rotated position, waiting to return");
      }
      break;

    case WAITING:
      if (millis() - waitStartMillis >= RETURN_DELAY_MS) {
        stepper.moveTo(0);
        motorState = MOVING_BACK;
        Serial.println("Returning motor to initial position");
      }
      break;

    case MOVING_BACK:
      stepper.run();
      if (stepper.distanceToGo() == 0) {
        motorState = IDLE;
        Serial.println("Motor back at initial position");
      }
      break;

    case IDLE:
    default:
      break;
  }
}

void readSerialCommands() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      serialBuffer.trim();
      if (serialBuffer == "ROTATE") {
        handleRotateCommand();
      }
      serialBuffer = "";
    } else if (c != '\r') {
      serialBuffer += c;
    }
  }
}

void handleRotateCommand() {
  if (motorState != IDLE) {
    Serial.println("ROTATE ignored, motor busy");
    return;
  }
  stepper.moveTo(ROTATE_STEPS);
  motorState = MOVING_OUT;
  Serial.println("ROTATE received, moving motor");
}
