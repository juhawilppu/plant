# Plant vitals - ESP32 sensor node

Goal: measure what a houseplant is actually experiencing - soil moisture, light
level, air temperature and humidity - on an ESP32, and log it somewhere readable.

Last updated 2026-09-13.

---

## SOURCING CONSTRAINT

**No AliExpress, Temu or similar.** Household rule. Everything below is sourced from
Finnish or EU shops with real consumer rights and days-not-weeks delivery.

The consequence is worth stating plainly: the same generic modules cost roughly three
to four times the Chinese-marketplace price, so the build lands around EUR 40 rather
than EUR 15. That changes how the parts list should be drawn up. Under AliExpress
pricing the sensible move was "every sensor is EUR 2, buy them all"; at EUR 8 a module
each sensor has to earn its place. Hence the trimmed list below.

---

## THE ORDER - Piikauppa, EUR 44.90 delivered

Piikauppa is a Finnish shop that ships from Finland and stocks every part needed.
Single order, no customs, no border. **ORDERED AND PAID 2026-09-13.** Parts
EUR 40.00 + Postipaketti EUR 4.90 = EUR 44.90 including EUR 8.13 VAT. Every line was
"Varastossa" (in stock) at checkout, so nothing is on backorder; domestic Postipaketti
normally runs 2-4 working days, and as the order went in on a Sunday that means
arrival around 16-18 September. Awaiting delivery.

| Part | Measures | EUR | Stock | Link |
|---|---|---|---|---|
| ESP32 WROOM-32D (micro USB, CP2102) | - | 13.90 | 37 | https://piikauppa.fi/kauppa/mikrokontrollerit/esp32/esp32-wroom-32d/ |
| Capacitive soil moisture sensor | soil water | 7.90 | 6 | https://piikauppa.fi/kauppa/tarvikkeet/anturit/kapasitiivinen-maankosteusanturi/ |
| AHT20 + BMP280 | air temp, humidity, pressure | 7.90 | 16 | https://piikauppa.fi/kauppa/tarvikkeet/anturit/aht20bmp280-yhdistelmaanturi/ |
| BH1750FVI **with diffuser dome** | light in lux | 6.90 | 15 | https://piikauppa.fi/kauppa/tarvikkeet/valoisuusanturit/bh1750fvi-valoisuusanturi-moduuli-kuvulla/ |
| Jumper wires 10 pcs, **20cm, Naaras-Naaras** | - | 3.40 | 33 | https://piikauppa.fi/kauppa/tarvikkeet/hyppylangat/hyppylanka-leipalautaan-koekytkentalautaan-10pkl/ |

**Take the 20 cm jumper wires, not the 10 cm.** Same product, two variants: the
10 cm Naaras-Naaras is at zero stock with an 11-working-day lead time, which would
hold up the whole order, while 20 cm has 33 in stock and ships immediately. It is
EUR 0.50 more and the better length for reaching from a board into a pot anyway.
Naaras-Naaras means female-female, which is what both the sensor modules and the
ESP32's male header pins need.

**Take the domed BH1750, not the bare one.** Piikauppa sells both; the bare module is
EUR 5.90 but out of stock, and the domed one at EUR 6.90 is the better part anyway. A
diffuser gives a roughly cosine-corrected response, so the reading depends much less
on the exact angle between the sensor and the window. For "how much light does this
spot actually get", angle-independence is the whole point.

### EU fallback if Piikauppa runs out

Botland (Poland, GLS, 2-7 days, shipping from EUR 10) has all of it in stock and
ships within 24 hours: ESP32-WROOM-32 DevKit EUR 11.50, capacitive soil moisture
EUR 5.50, BME280 EUR 7.90, BH1750 EUR 3.90, female-female 4-pin cables 5 pcs
EUR 2.50. That is EUR 31.30 of parts but EUR 41.30 delivered, so it only wins if
Piikauppa is out of something.

Botland is also where the upgrade lives: **DFRobot Gravity SEN0308, a fully
waterproof capacitive probe, EUR 14.90.** Worth considering because the probe sits in
damp soil permanently, and the failure mode of generic capacitive probes is water
wicking into the exposed PCB edge at the top over months. If the node is meant to run
for years unattended, that is the part to spend on.

Note Botland's BME280 where Piikauppa has AHT20+BMP280. Either is fine: BME280 is one
Bosch chip doing temp, humidity and pressure; the combo module is two chips doing the
same. AHT20 humidity is marginally more accurate, BME280 is one driver instead of two.
Not a decision worth agonising over.

### Deliberately NOT buying

- **DS18B20 soil temperature probe.** Root-zone temperature is marginal for an indoor
  plant - air temperature is a fine proxy indoors, and the DS18B20 earns its place
  outdoors or in a greenhouse, not on a windowsill. Dropping it also removes the
  4.7 kOhm pull-up resistor it needs, which Piikauppa charges EUR 3.49 for. If it is
  wanted later: Piikauppa EUR 3.90 for the 1 m stainless probe, or Botland EUR 2.50.
- **A second ESP32.** One node, one board.
- **Battery hardware.** See the power section: start on mains USB.

---

## PIN PLAN

Decided in advance so assembly is mechanical rather than improvised. Classic ESP32
WROOM-32, so the default I2C pins apply.

| Signal | ESP32 pin | Goes to |
|---|---|---|
| 3.3V | 3V3 | VCC on all three sensors |
| Ground | GND | GND on all three sensors |
| I2C data | GPIO21 (SDA) | AHT20+BMP280 SDA, BH1750 SDA |
| I2C clock | GPIO22 (SCL) | AHT20+BMP280 SCL, BH1750 SCL |
| Soil moisture analog | **GPIO34** | AOUT on the capacitive probe |

**Why GPIO34 for the probe.** It is on ADC1, which keeps working while WiFi is
active, and it is one of the input-only pins (GPIO34-39), so there is no internal
pull-up or output driver to interfere with an analog reading. GPIO32, 33, 35, 36 and
39 are equally valid ADC1 alternatives if the layout suggests otherwise.

**Pins to leave alone.** GPIO6-11 are wired to the flash chip and will brick a boot
if used. GPIO0, 2, 12 and 15 are strapping pins that decide boot mode, so a sensor
holding one at the wrong level at power-up prevents booting. Nothing in this build
needs them.

**Leave the BH1750's ADDR pin unconnected**, which selects address 0x23. Expect to
see 0x23 (BH1750), 0x38 (AHT20) and 0x76 or 0x77 (BMP280) on the I2C scan.

## WIRING NOTES

**Everything runs at 3.3V.** All three sensors accept 3.3V, and the ESP32's GPIOs are
3.3V, so power them all from the board's 3V3 pin. Do not power a sensor from the 5V
pin and feed its output into a GPIO.

**The two digital sensors share one I2C bus.** SDA and SCL are a bus, so AHT20
(0x38), BMP280 (0x76 or 0x77) and BH1750 (0x23, or 0x5C if ADDR is pulled high) all
hang off the same two pins. Their addresses differ, so there is no conflict. Run an
I2C scanner sketch first and confirm three addresses appear before writing any driver
code - that single step separates "wiring is wrong" from "library is wrong", which is
otherwise a miserable thing to debug.

**Put the soil probe's analog output on an ADC1 pin: GPIO32-39.** This is the classic
ESP32 trap. ADC2 is shared with the WiFi radio and returns garbage, or blocks,
whenever WiFi is active - so a moisture reading that is perfect on the bench silently
breaks the moment the node starts uploading.

**Calibrate the soil probe with two readings, not from the datasheet.** Note the raw
value in air (dry end) and in a glass of water (wet end); everything useful is a
percentage between those two. Absolute numbers from a capacitive probe mean nothing
on their own, and they differ between soil types anyway.

---

## POWER

**Mains USB. A 5V phone charger and a micro-USB cable to the pot.** An ESP32 with WiFi
active draws roughly 80-160 mA, which is trivial from a charger and impossible from
small batteries. Zero maintenance, nothing to recharge, and the node can sample
continuously instead of in bursts. For an indoor plant within reach of a socket this
is simply the right answer, and it is worth resisting the temptation to make the first
build battery powered.

**If it ever has to go batteried**, the plan is deep sleep: wake every 15-30 minutes,
read, push one sample over WiFi, sleep. The catch is that this board is the wrong
board for it - on a generic dev board the CP2102 USB-serial chip and the linear
regulator keep drawing current in sleep, so the node idles around 0.5-2 mA instead of
the ESP32 chip's own ~10 uA, turning an 18650's theoretical months into weeks. Boards
built for battery use - LOLIN D32 with its onboard LiPo charger, or a FireBeetle ESP32,
designed specifically for low deep-sleep current - do far better. That is a EUR 10
decision to take later with real measurements, not now.

---

## NEXT ACTIONS

1. Pay for the Piikauppa cart (EUR 44.90 delivered), already built and waiting in
   Chrome. Soil moisture sensor shows only 6 in stock, so it is the one item worth
   not sitting on.
2. While waiting: install the Arduino IDE with the ESP32 board support URL, or set up
   ESPHome if the readings are headed for Home Assistant rather than a serial log.
3. On arrival: I2C scanner sketch first, confirm three addresses, then one sensor at
   a time.
4. Calibrate the soil probe in air and in water before it goes anywhere near a plant.
5. Decide where readings land - serial log, MQTT, Home Assistant, or a plain web page
   served by the ESP32 itself.
