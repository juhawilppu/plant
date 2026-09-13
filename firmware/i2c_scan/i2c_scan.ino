// Step one on arrival day: prove the wiring before trusting any driver.
//
// Expect exactly three addresses on this build:
//   0x23  BH1750 light sensor (ADDR pin left unconnected)
//   0x38  AHT20 temperature + humidity
//   0x76  or 0x77 - BMP280 pressure, depending on the module
//
// If nothing appears at all, it is power or SDA/SCL swapped. If one is missing,
// it is that module's wiring. Doing this first separates "wiring is wrong" from
// "library is wrong", which is otherwise a miserable thing to debug.

#include <Wire.h>

static const int SDA_PIN = 21;
static const int SCL_PIN = 22;

void setup() {
    Serial.begin(115200);
    delay(500);
    Wire.begin(SDA_PIN, SCL_PIN);
    Serial.println("\nI2C scan");
}

void loop() {
    int found = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("  found 0x%02X\n", addr);
            found++;
        }
    }
    Serial.printf("%d device(s)\n\n", found);
    delay(5000);
}
