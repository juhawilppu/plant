// Plant vitals node: ESP32 WROOM-32, three sensors, publishes JSON over MQTT.
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
//   "PubSubClient" by Nick O'Leary
//
// Board: "ESP32 Dev Module". Upload speed 921600 is fine; if uploads fail, drop
// to 115200 before suspecting the board.
//
// Speaks the MQTT contract server/mqtt-bridge.js expects: same topics, same
// Last Will, same msg_id scheme - see mosquitto/config/acl and
// server/mqtt-bridge.js for the other end of this.
//
// UNTESTED against real hardware - written while the parts were in the post.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoOTA.h>
#include <Wire.h>
#include <Adafruit_AHTX0.h>
#include <Adafruit_BMP280.h>
#include <BH1750.h>

#include "secrets.h"

// So updates never need a USB cable once this is running on the windowsill.
static const char *OTA_HOSTNAME = "esp32-ota";

static const int SDA_PIN = 21;
static const int SCL_PIN = 22;
static const int SOIL_PIN = 34;

static const char *MQTT_HOST = "mqtt.juhawilppu.com";
static const uint16_t MQTT_PORT = 8883;

// TEMPORARY: 1 minute for bring-up, to see readings land quickly while only
// the soil probe is wired. Soil moisture in a pot changes over hours, so this
// should go back to 5 minutes (5UL * 60UL * 1000UL) once bring-up is done -
// anything faster than that just fills the table for no benefit.
static const uint32_t INTERVAL_MS = 1UL * 60UL * 1000UL;

// How often to retry a dropped MQTT connection. Kept short relative to
// INTERVAL_MS so a blip near publish time does not cost a whole cycle.
static const uint32_t MQTT_RETRY_MS = 5000UL;

// ISRG Root X1, the Let's Encrypt root. Pinned so a man-in-the-middle cannot
// impersonate the broker with a self-signed or otherwise-issued certificate -
// the alternative, setInsecure(), would accept any certificate at all.
// Expires 2035-06-04; replace from https://letsencrypt.org/certs/isrgrootx1.pem
// if it is ever rotated before then.
static const char *MQTT_ROOT_CA = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

Adafruit_AHTX0 aht;
Adafruit_BMP280 bmp;
BH1750 lightMeter;

bool haveAht = false;
bool haveBmp = false;
bool haveLight = false;

WiFiClientSecure tlsClient;
PubSubClient mqttClient(tlsClient);

String readingTopic;
String statusTopic;
String clientId;

// Seeded from the ESP32's hardware RNG rather than counting from zero: a
// reboot should not restart the counter where a previous session already
// left off, or a coincidental repeat would be silently swallowed by the
// (device_id, msg_id) dedup index on the server.
uint32_t msgId = 0;

uint32_t lastPublish = 0;
uint32_t lastMqttAttempt = 0;
bool otaStarted = false;

void beginOta() {
    if (otaStarted) return;
    otaStarted = true;

    ArduinoOTA.setHostname(OTA_HOSTNAME);
    ArduinoOTA.setPassword(OTA_PASSWORD);

    ArduinoOTA.onStart([]() {
        Serial.println("OTA start");
    });
    ArduinoOTA.onEnd([]() {
        Serial.println("\nOTA end");
    });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        Serial.printf("OTA progress: %u%%\r", (progress * 100) / total);
    });
    ArduinoOTA.onError([](ota_error_t error) {
        Serial.printf("OTA error[%u]\n", error);
    });

    ArduinoOTA.begin();
    Serial.println("OTA ready. Hostname: " + String(OTA_HOSTNAME));
}

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

    // Bounded wait. Failing here is not fatal: the loop simply tries again on
    // its next pass, which is the right behaviour for a router reboot.
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
        delay(500);
        Serial.print(".");
    }
    Serial.println(WiFi.status() == WL_CONNECTED ? " ok" : " FAILED");
    if (WiFi.status() == WL_CONNECTED) Serial.println(WiFi.localIP().toString());
}

// Non-blocking: tries at most once per MQTT_RETRY_MS, so a dead broker does
// not stall sensor reads or the WiFi check behind a long blocking retry loop.
void connectMqttIfDue() {
    if (mqttClient.connected()) return;
    if (WiFi.status() != WL_CONNECTED) return;

    const uint32_t now = millis();
    if (lastMqttAttempt != 0 && now - lastMqttAttempt < MQTT_RETRY_MS) return;
    lastMqttAttempt = now;

    Serial.printf("MQTT: connecting to %s:%u as plantnode\n", MQTT_HOST, MQTT_PORT);

    // Last Will: if this session drops without a clean disconnect, the broker
    // publishes "offline" on the node's behalf - see mqtt-bridge.js and the
    // README's "Why MQTT" section. Retained, so it survives until overwritten.
    const bool ok = mqttClient.connect(
        clientId.c_str(), "plantnode", MQTT_NODE_PASSWORD,
        statusTopic.c_str(), 1, true, "offline", true);

    if (!ok) {
        Serial.printf("MQTT: connect failed, rc=%d\n", mqttClient.state());
        return;
    }

    Serial.println("MQTT: connected");
    // Retained, so anything that subscribes later immediately learns the node
    // is up without waiting for the next cycle.
    mqttClient.publish(statusTopic.c_str(), "online", true);
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

    randomSeed(esp_random());
    msgId = esp_random() % 100000;

    readingTopic = String("plants/") + DEVICE_ID + "/reading";
    statusTopic = String("plants/") + DEVICE_ID + "/status";
    clientId = String("plant-node-") + DEVICE_ID;

    tlsClient.setCACert(MQTT_ROOT_CA);
    mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    // Default 256 bytes is too small for this payload plus topic and MQTT
    // overhead; the reading body alone can run past 300.
    mqttClient.setBufferSize(384);
    // Well above INTERVAL_MS so the broker never sees a spurious timeout on
    // this connection, while client.loop() below still keeps PINGREQ flowing.
    mqttClient.setKeepAlive(60);

    connectWifi();
    beginOta();
    connectMqttIfDue();
}

void publishReading() {
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
    char body[384];
    int n = snprintf(body, sizeof(body),
                      "{\"device_id\":\"%s\",\"msg_id\":%lu,\"soil_raw\":%d",
                      DEVICE_ID, (unsigned long) (msgId + 1), soilRaw);
    if (!isnan(tempC))    n += snprintf(body + n, sizeof(body) - n, ",\"air_temp_c\":%.2f", tempC);
    if (!isnan(humidity)) n += snprintf(body + n, sizeof(body) - n, ",\"humidity_pct\":%.2f", humidity);
    if (!isnan(pressure)) n += snprintf(body + n, sizeof(body) - n, ",\"pressure_hpa\":%.2f", pressure);
    if (!isnan(lux))      n += snprintf(body + n, sizeof(body) - n, ",\"lux\":%.1f", lux);
    n += snprintf(body + n, sizeof(body) - n, ",\"rssi\":%d,\"uptime_s\":%lu}",
                  WiFi.RSSI(), (unsigned long) (millis() / 1000));

    Serial.printf("PUBLISH %s %s\n", readingTopic.c_str(), body);

    // Not retained: a stale reading should not be handed to a subscriber that
    // connects between cycles - that is what the retained status topic is
    // for. Sent at whatever QoS PubSubClient's publish() gives us, which is
    // QoS 0: the library does not track PUBACKs for its own publishes, unlike
    // the Last Will above (a CONNECT-packet flag, handled independently). A
    // dropped reading here is simply missing from the table, and five-minute
    // samples tolerate the occasional gap.
    if (mqttClient.publish(readingTopic.c_str(), body, false)) {
        msgId++;
    } else {
        Serial.println("  -> publish failed");
    }
}

void loop() {
    connectWifi();
    connectMqttIfDue();
    // Must run often: this is what sends PINGREQ and keeps the broker from
    // timing out the connection between five-minute publishes, and what
    // would process incoming messages if this node ever subscribed to any.
    mqttClient.loop();
    ArduinoOTA.handle();

    const uint32_t now = millis();
    if (lastPublish == 0 || now - lastPublish >= INTERVAL_MS) {
        lastPublish = now;
        if (mqttClient.connected()) {
            publishReading();
        } else {
            Serial.println("skipping publish, MQTT not connected");
        }
    }

    delay(50);
}
