#include <AccelStepper.h>

// Define step and direction pins (using a driver like TB6600 or DM542)
const int stepPin = 6;
const int dirPin = 5;

// Create an instance in driver mode (1)
AccelStepper stepper(AccelStepper::DRIVER, stepPin, dirPin);

// How far to rotate on each trigger. The return trip is no longer timed
// locally: the server tells us when it's time to come back (RETURN), once
// the discharge audio has actually finished playing. This board just reports
// "REACHED" when it arrives at the rotated position, so the server knows
// when it's safe to start the audio (and the motor sound isn't stepped on).
//
// ROTATE_STEPS is in driver microsteps, not motor degrees or full steps.
// Driver is set to microstep 8 => 1600 pulses/rev, so:
//   ROTATE_STEPS = (desired_angle_degrees / 360) * 1600
// e.g. 67 steps for ~15 degrees, 89 for ~20 degrees, 133 for ~30 degrees.
// Recompute this if the driver's microstep DIP switches change.
const long ROTATE_STEPS = 380; // (desired_angle_degrees / 360) * 1600

enum MotorState { IDLE, MOVING_OUT, WAITING, MOVING_BACK };
MotorState motorState = IDLE;

String serialBuffer = "";

void setup() {
  Serial.begin(9600);

  stepper.setMaxSpeed(100.0);
  stepper.setAcceleration(50.0); // required for run()/moveTo() to move at all - without this, acceleration defaults to 0 and computed speed stays 0
}

void loop() {
  readSerialCommands();

  switch (motorState) {
    case MOVING_OUT:
      stepper.run();
      if (stepper.distanceToGo() == 0) {
        motorState = WAITING;
        // Machine-parseable line the server watches for to know when it's
        // safe to start the discharge audio - keep this exact token stable.
        Serial.println("REACHED");
      }
      break;

    case WAITING:
      // Sits here indefinitely until the server sends RETURN - no local
      // timer, so the motor never moves back before the server says the
      // audio is actually done.
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
      } else if (serialBuffer == "RETURN") {
        handleReturnCommand();
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

void handleReturnCommand() {
  if (motorState != WAITING) {
    Serial.println("RETURN ignored, motor not waiting");
    return;
  }
  stepper.moveTo(0);
  motorState = MOVING_BACK;
  Serial.println("RETURN received, returning motor to initial position");
}
