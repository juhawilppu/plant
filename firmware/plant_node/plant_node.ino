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
//   "MQTT" by Joel Gaehwiler (256dpi/arduino-mqtt), not PubSubClient: this
//   one can publish at QoS 1 and wait for the broker's PUBACK, which is what
//   lets a reading leave the buffer only once the broker has it
//
// Board: "ESP32 Dev Module". Upload speed 921600 is fine; if uploads fail, drop
// to 115200 before suspecting the board.
//
// Speaks the MQTT contract server/mqtt-bridge.js expects: same topics, same
// Last Will, same msg_id scheme - see mosquitto/config/acl and
// server/mqtt-bridge.js for the other end of this.
//
// Every reading goes into a buffer first and leaves it only when the broker
// acks it, so a WiFi drop or a broker restart delays readings instead of
// losing them. See "The buffer" below.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <MQTT.h>
#include <Preferences.h>
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

// One reading a minute. Far faster than soil moisture changes, but it keeps the
// dashboard live, and 1,440 rows a day is still nothing for Postgres.
static const uint32_t INTERVAL_MS = 1UL * 60UL * 1000UL;

// A day of readings at INTERVAL_MS, 28 bytes each: 40 KB of the ESP32's RAM.
// Past that the oldest reading is dropped to make room: after a day offline the
// recent readings are the ones worth having.
static const size_t BUFFER_CAPACITY = 1440;

// How long one pass of loop() may spend sending the backlog. Each publish waits
// for its PUBACK, so a full day's backlog takes a few minutes; this keeps OTA
// and the MQTT keepalive serviced while it drains.
static const uint32_t DRAIN_BUDGET_MS = 2000UL;

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
// Sized for one reading plus the topic and MQTT framing.
MQTTClient mqttClient(512);

String readingTopic;
String statusTopic;
String clientId;

// msg_id is what the server deduplicates on, so it must never repeat for this
// device: a repeat is silently dropped as a duplicate. It is the boot count in
// the high 32 bits and a per-boot sequence in the low 32. The boot count lives
// in flash (NVS) and is bumped once per boot, which is a single write and no
// wear worth counting. The earlier scheme, a random start below 100,000, would
// have collided with its own history after a couple of months of readings.
// Stays under 2^53, so JSON and JavaScript carry it exactly.
uint32_t bootId = 0;
uint32_t seq = 0;

// The buffer. A ring of readings not yet acked by the broker, oldest at head.
// Each keeps the millis() it was taken at, and is sent with its age, so the
// server can date it correctly however late it arrives (see ingest() in
// server/index.js). Held in RAM, so a reboot loses what is in it; the age is
// only meaningful within one boot anyway, since millis() restarts at zero.
struct Reading {
    uint32_t seq;
    uint32_t takenAtMs;
    float tempC, humidity, pressure, lux;   // NAN when the sensor gave nothing
    int16_t soilRaw;
    int8_t rssi;                            // 0 when WiFi was down
};

Reading buffer[BUFFER_CAPACITY];
size_t head = 0;
size_t count = 0;
uint32_t dropped = 0;

uint32_t lastReading = 0;
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

    if (!mqttClient.connect(clientId.c_str(), "plantnode", MQTT_NODE_PASSWORD)) {
        Serial.printf("MQTT: connect failed, error=%d rc=%d\n",
                      mqttClient.lastError(), mqttClient.returnCode());
        return;
    }

    Serial.println("MQTT: connected");
    // Retained, so anything that subscribes later immediately learns the node
    // is up without waiting for the next cycle.
    mqttClient.publish(statusTopic.c_str(), "online", true, 1);
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

    Preferences prefs;
    prefs.begin("plant-node", false);
    bootId = prefs.getUInt("boot", 0) + 1;
    prefs.putUInt("boot", bootId);
    prefs.end();
    Serial.printf("boot %lu\n", (unsigned long) bootId);

    readingTopic = String("plants/") + DEVICE_ID + "/reading";
    statusTopic = String("plants/") + DEVICE_ID + "/status";
    clientId = String("plant-node-") + DEVICE_ID;

    tlsClient.setCACert(MQTT_ROOT_CA);
    mqttClient.begin(MQTT_HOST, MQTT_PORT, tlsClient);
    // Last Will: if this session drops without a clean disconnect, the broker
    // publishes "offline" on the node's behalf - see mqtt-bridge.js and the
    // README's "Why MQTT" section. Retained, so it survives until overwritten.
    mqttClient.setWill(statusTopic.c_str(), "offline", true, 1);
    // Independent of INTERVAL_MS: client.loop() below sends a PINGREQ whenever
    // the connection has been quiet this long, so the broker never sees a
    // spurious timeout between readings.
    mqttClient.setKeepAlive(60);
    // How long a publish waits for its PUBACK. Past it the library closes the
    // connection, the reading stays in the buffer, and the reconnect retries.
    mqttClient.setTimeout(5000);

    connectWifi();
    beginOta();
    connectMqttIfDue();
}

// Measures now and puts the reading at the back of the buffer, whether or not
// there is a connection to send it on.
void takeReading() {
    Reading r;
    r.seq = ++seq;
    r.takenAtMs = millis();
    r.soilRaw = readSoilRaw();
    r.tempC = r.humidity = r.pressure = r.lux = NAN;

    if (haveAht) {
        sensors_event_t humidityEvent, tempEvent;
        // A read can fail even after a successful begin() - e.g. if something
        // else on the shared I2C bus wedges it in between. Treat that the
        // same as "sensor absent" rather than publishing whatever garbage was
        // left on the stack in the unfilled event structs.
        if (aht.getEvent(&humidityEvent, &tempEvent)) {
            r.tempC = tempEvent.temperature;
            r.humidity = humidityEvent.relative_humidity;
        } else {
            Serial.println("AHT20: read failed, skipping this cycle");
        }
    }
    // Air temperature comes from the AHT20; the BMP280 is only asked for
    // pressure, because its own temperature reading runs warm from self-heating.
    if (haveBmp) r.pressure = bmp.readPressure() / 100.0f;
    if (haveLight) r.lux = lightMeter.readLightLevel();
    r.rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;

    if (count == BUFFER_CAPACITY) {
        head = (head + 1) % BUFFER_CAPACITY;
        count--;
        dropped++;
        Serial.printf("buffer full, dropped the oldest reading (%lu so far)\n",
                      (unsigned long) dropped);
    }
    buffer[(head + count) % BUFFER_CAPACITY] = r;
    count++;
    Serial.printf("reading %lu taken, %u waiting\n", (unsigned long) r.seq, (unsigned) count);
}

// Publishes one reading at QoS 1. True only once the broker has acked it.
bool sendReading(const Reading &r) {
    // Hand-rolled rather than pulling in ArduinoJson: this is one flat object
    // and snprintf is clearer than a library for it. A sensor that gave nothing
    // is omitted, and the server stores null for it rather than recording a
    // fabricated zero.
    const uint64_t msgId = ((uint64_t) bootId << 32) | r.seq;
    char body[384];
    int n = snprintf(body, sizeof(body),
                     "{\"device_id\":\"%s\",\"msg_id\":%llu,\"soil_raw\":%d",
                     DEVICE_ID, (unsigned long long) msgId, r.soilRaw);
    if (!isnan(r.tempC))    n += snprintf(body + n, sizeof(body) - n, ",\"air_temp_c\":%.2f", r.tempC);
    if (!isnan(r.humidity)) n += snprintf(body + n, sizeof(body) - n, ",\"humidity_pct\":%.2f", r.humidity);
    if (!isnan(r.pressure)) n += snprintf(body + n, sizeof(body) - n, ",\"pressure_hpa\":%.2f", r.pressure);
    if (!isnan(r.lux))      n += snprintf(body + n, sizeof(body) - n, ",\"lux\":%.1f", r.lux);
    if (r.rssi != 0)        n += snprintf(body + n, sizeof(body) - n, ",\"rssi\":%d", r.rssi);
    // The age is worked out now, at send time, so it covers however long the
    // reading sat in the buffer. Unsigned subtraction survives millis()
    // wrapping at 49 days.
    n += snprintf(body + n, sizeof(body) - n, ",\"uptime_s\":%lu,\"age_ms\":%lu}",
                  (unsigned long) (r.takenAtMs / 1000),
                  (unsigned long) (millis() - r.takenAtMs));

    Serial.printf("PUBLISH %s %s\n", readingTopic.c_str(), body);

    // Not retained: a stale reading should not be handed to a subscriber that
    // connects between cycles - that is what the retained status topic is
    // for. QoS 1, and this blocks until the PUBACK arrives or the timeout
    // passes. A PUBACK that is lost on the way back means the reading is sent
    // again, with the same msg_id, and the server's dedup index drops the
    // repeat: at-least-once here, exactly-once in the table.
    if (mqttClient.publish(readingTopic.c_str(), body, false, 1)) return true;
    Serial.printf("  -> not acked, error=%d; kept for the next try\n", mqttClient.lastError());
    return false;
}

// Sends the buffer oldest first, so readings reach the server in the order they
// were taken and the dashboard's live view, which ignores a reading older than
// the last one it has, never skips one. Stops at the first failure: sending the
// next reading before this one would break that order.
void drainBuffer() {
    const uint32_t started = millis();
    while (count > 0 && mqttClient.connected() && millis() - started < DRAIN_BUDGET_MS) {
        if (!sendReading(buffer[head])) return;
        head = (head + 1) % BUFFER_CAPACITY;
        count--;
    }
}

void loop() {
    connectWifi();
    connectMqttIfDue();
    // Must run often: this is what sends PINGREQ and keeps the broker from
    // timing out the connection between readings, and what would process
    // incoming messages if this node ever subscribed to any.
    mqttClient.loop();
    ArduinoOTA.handle();

    const uint32_t now = millis();
    if (lastReading == 0 || now - lastReading >= INTERVAL_MS) {
        lastReading = now;
        takeReading();
    }
    drainBuffer();

    delay(50);
}
