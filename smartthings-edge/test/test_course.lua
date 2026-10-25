-- lua test/test_course.lua — programme table and settings, with the real lists of the WW10H9400EW.
package.path = arg[0]:gsub("[^/]*$", "") .. "../src/?.lua;" .. package.path
local course = require "course"
local failures = 0
local function check(name, cond)
  if cond then print("ok   " .. name) else print("FAIL " .. name); failures = failures + 1 end
end
local function same(a, b) return table.concat(a, ",") == table.concat(b, ",") end

-- WM_FUN_OPT_LIST_INDOOR and WM_FUN_COURSE_LIST as sent by the machine
local OPT_LIST = "3E84109308A53F2F847E933FA53F2C843E923FA41F30833E933FA30F31841E943FA41F47843E923FA53F34811E923FA41F35831E930FA41F37867E943FA53F11841E930FA30F48831E920FA2073A841E930FA30F3B80009001A53E198000913FA53F3385209204A2041B8410943FA41F418410933FA53F438520943FA53F428410933FA41F1E8410943FA41F1F8410933FA41F3F843E923FA53F"
local COURSE_LIST = "3E/2F/2C/30/31/47/34/35/37/11/48/3A/3B/19/33/1B/41/43/42/1E/1F/3F"

local known = true
for code in COURSE_LIST:gmatch("%x%x") do known = known and course.by_code(code) ~= nil end
check("the 22 programmes of the machine are all known", known and #course.PROGRAMMES == 22)
check("screen order", course.names()[1] == "SmartWash" and course.names()[22] == "CottonEco")
check("names = machine names", course.names()[2] == "Cotton" and #course.names() == 22)
check("by name, French screen label", course.by_name("Cotton").screen_fr == "Coton" and course.by_name("DelicatesWash").code == "48")

local o = course.decode_option("2F8493A5")
check("decode Coton 40 / 3 / 1400", o.code == "2F" and o.temperature == 4 and o.rinse == 3 and o.spin == 5)
check("encode round trip", course.encode_option(o) == "2F8493A5")
check("decode rejects junk", course.decode_option("2F84") == nil and course.decode_option(nil) == nil)
check("describe", course.describe("2C8392A4") == "Synthetics, 30 °C, 2 rinse(s), 1200 rpm")

local list = course.parse_option_list(OPT_LIST)
local n = 0; for _ in pairs(list) do n = n + 1 end
check("22 entries parsed", n == 22)
check("Coton default = what the screen showed", course.encode_option(list["2F"].default) == "2F8493A5")

local s = course.supported(list["2F"])
check("Coton temperatures", same(s.temperatures, { "cold", "20", "30", "40", "60", "95" }))
check("Coton spins", same(s.spins, { "rinseHold", "noSpin", "400", "800", "1200", "1400" }))
check("Coton rinses", same(s.rinses, { "0", "1", "2", "3", "4", "5" }))
s = course.supported(list["48"])
check("Delicates: 40 °C and 400 rpm at most", same(s.temperatures, { "cold", "20", "30", "40" }) and same(s.spins, { "rinseHold", "noSpin", "400" }))
s = course.supported(list["3B"])
check("Essorage: no temperature", same(s.temperatures, { "none" }) and same(s.rinses, { "0" }))
s = course.supported(list["33"])
check("Nettoyage tambour: fixed", same(s.temperatures, { "60" }) and same(s.spins, { "400" }) and same(s.rinses, { "2" }))

check("set temperature", course.with_setting("2F8493A5", list["2F"], "temperature", "30") == "2F8393A5")
check("set spin", course.with_setting("2F8493A5", list["2F"], "spin", "800") == "2F8493A3")
check("set rinses", course.with_setting("2F8493A5", list["2F"], "rinse", "2") == "2F8492A5")
check("same settings as the panel test: Synthetics 30 / 2 / 1200",
  course.with_setting(course.encode_option(list["2C"].default), list["2C"], "temperature", "30") == "2C8392A4")
local v, err = course.with_setting("488392A2", list["48"], "spin", "1400")
check("refuses 1400 rpm on Delicates", v == nil and err:match("spin") ~= nil)
v, err = course.with_setting("488392A2", list["48"], "temperature", "95")
check("refuses 95 °C on Delicates", v == nil)

if failures > 0 then print(failures .. " failure(s)"); os.exit(1) end
print("all tests pass")
