// Plant vitals node: ESP32 WROOM-32, three sensors, posts JSON over WiFi.
//
// Wiring (see docs/hardware.md for why):
//   3V3            -> VCC on all three sensor modules
//   GND            -> GND on all three
//   GPIO21 (SDA)   -> AHT20+BMP280 SDA, BH1750 SDA
//   GPIO22 (SCL)   -> AHT20+BMP280 SCL, BH1750 SCL
//   GPIO34         -> AOUT on the capacitive soil probe
//
// Libraries to install in the Arduino IDE Library Manager:
//   "Adafruit AHTX0"       (pulls in Adafruit BusIO + Unified Sensor)
//   "Adafruit BMP280 Library"
//   "BH1750" by Christopher Laws
//
// Board: "ESP32 Dev Module". Upload speed 921600 is fine; if uploads fail, drop
// to 115200 before suspecting the board.
//
// UNTESTED against real hardware - written while the parts were in the post.

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <Adafruit_AHTX0.h>
#include <Adafruit_BMP280.h>
#include <BH1750.h>

#include "secrets.h"

static const int SDA_PIN = 21;
static const int SCL_PIN = 22;
static const int SOIL_PIN = 34;

// Five minutes. Soil moisture in a pot changes over hours, so anything faster
// just fills the table; the air sensors are along for the ride.
static const uint32_t INTERVAL_MS = 5UL * 60UL * 1000UL;

Adafruit_AHTX0 aht;
Adafruit_BMP280 bmp;
BH1750 lightMeter;

bool haveAht = false;
bool haveBmp = false;
bool haveLight = false;

// The soil probe's analog output is noisy enough that a single sample jumps
// around by tens of counts. Sixteen samples averaged is plenty and costs 16 ms.
int readSoilRaw() {
    long sum = 0;
    for (int i = 0; i < 16; i++) {
        sum += analogRead(SOIL_PIN);
        delay(1);
    }
    return (int) (sum / 16);
}

void connectWifi() {
    if (WiFi.status() == WL_CONNECTED) return;

    Serial.printf("WiFi: connecting to %s", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    // Bounded wait. Failing here is not fatal: the loop simply tries again at
    // the next interval, which is the right behaviour for a router reboot.
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
        delay(500);
        Serial.print(".");
    }
    Serial.println(WiFi.status() == WL_CONNECTED ? " ok" : " FAILED");
    if (WiFi.status() == WL_CONNECTED) Serial.println(WiFi.localIP().toString());
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\nplant-vitals node starting");

    Wire.begin(SDA_PIN, SCL_PIN);

    haveAht = aht.begin();
    Serial.printf("AHT20:  %s\n", haveAht ? "ok" : "NOT FOUND");

    // These combo modules put the BMP280 at 0x77, but some batches use 0x76.
    haveBmp = bmp.begin(0x77) || bmp.begin(0x76);
    Serial.printf("BMP280: %s\n", haveBmp ? "ok" : "NOT FOUND");

    haveLight = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
    Serial.printf("BH1750: %s\n", haveLight ? "ok" : "NOT FOUND");

    connectWifi();
}

void postReading() {
    const int soilRaw = readSoilRaw();

    float tempC = NAN, humidity = NAN, pressure = NAN, lux = NAN;

    if (haveAht) {
        sensors_event_t humidityEvent, tempEvent;
        aht.getEvent(&humidityEvent, &tempEvent);
        tempC = tempEvent.temperature;
        humidity = humidityEvent.relative_humidity;
    }
    // Air temperature comes from the AHT20; the BMP280 is only asked for
    // pressure, because its own temperature reading runs warm from self-heating.
    if (haveBmp) pressure = bmp.readPressure() / 100.0f;
    if (haveLight) lux = lightMeter.readLightLevel();

    // Hand-rolled rather than pulling in ArduinoJson: this is one flat object
    // and snprintf is clearer than a library for it. A sensor that did not
    // initialise is omitted, and the server stores null for it rather than
    // recording a fabricated zero.
    char body[320];
    int n = snprintf(body, sizeof(body), "{\"device_id\":\"%s\",\"soil_raw\":%d", DEVICE_ID, soilRaw);
    if (!isnan(tempC))    n += snprintf(body + n, sizeof(body) - n, ",\"air_temp_c\":%.2f", tempC);
    if (!isnan(humidity)) n += snprintf(body + n, sizeof(body) - n, ",\"humidity_pct\":%.2f", humidity);
    if (!isnan(pressure)) n += snprintf(body + n, sizeof(body) - n, ",\"pressure_hpa\":%.2f", pressure);
    if (!isnan(lux))      n += snprintf(body + n, sizeof(body) - n, ",\"lux\":%.1f", lux);
    n += snprintf(body + n, sizeof(body) - n, ",\"rssi\":%d,\"uptime_s\":%lu}",
                  WiFi.RSSI(), (unsigned long) (millis() / 1000));

    Serial.printf("POST %s\n", body);

    HTTPClient http;
    const bool useTls = strncmp(SERVER_URL, "https://", 8) == 0;

    // WiFiClientSecure has to outlive the request, so it is declared here
    // rather than inside the branch.
    WiFiClientSecure secureClient;
    WiFiClient plainClient;

    if (useTls) {
        // setInsecure() skips server certificate validation: the connection is
        // still encrypted, but an active man-in-the-middle could impersonate the
        // server and capture the ingest token. Acceptable for a houseplant on a
        // home network; to close it properly, pin the CA root by fetching it
        //   openssl s_client -showcerts -connect your.host:443 </dev/null
        // and replacing this line with secureClient.setCACert(rootCaPem).
        secureClient.setInsecure();
        http.begin(secureClient, SERVER_URL);
    } else {
        http.begin(plainClient, SERVER_URL);
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Token", INGEST_TOKEN);
    http.setTimeout(10000);

    const int code = http.POST((uint8_t *) body, strlen(body));
    if (code > 0) {
        Serial.printf("  -> %d %s\n", code, http.getString().c_str());
    } else {
        Serial.printf("  -> failed: %s\n", http.errorToString(code).c_str());
    }
    http.end();
}

void loop() {
    connectWifi();
    if (WiFi.status() == WL_CONNECTED) {
        postReading();
    } else {
        Serial.println("skipping post, no WiFi");
    }
    delay(INTERVAL_MS);
}
