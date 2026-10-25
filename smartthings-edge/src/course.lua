-- Programmes and settings of the WW10H9400EW ("WW9000HE"), read from the
-- machine on 24/10/2026 by changing them on its touch screen.
--
-- WM_FUN_COURSE_OPTION = 4 hex bytes: programme code, then 8t (temperature
-- index), 9r (rinse count), As (spin index), e.g. "2F8493A5" = Coton 40 °C,
-- 3 rinses, 1400 rpm. Writing it (Smart Control on) changes the programme and
-- the settings without starting.
-- WM_FUN_OPT_LIST_INDOOR = 7 bytes per programme: code, 8t default, allowed
-- temperatures (bit i = index i), 9r default, allowed rinses, As default,
-- allowed spins.

local M = {}

-- In the order of the touch screen; screen_fr = label on the (French) screen.
M.PROGRAMMES = {
  { code = "3E", name = "SmartWash", screen_fr = "Lavage auto optimal" },
  { code = "2F", name = "Cotton", screen_fr = "Coton" },
  { code = "2C", name = "Synthetics", screen_fr = "Synthétiques" },
  { code = "30", name = "Denim", screen_fr = "Jeans" },
  { code = "31", name = "DarkGarment", screen_fr = "Couleurs" },
  { code = "47", name = "SuperSpeed", screen_fr = "Super rapide" },
  { code = "34", name = "SuperEcoWash", screen_fr = "Eco" },
  { code = "35", name = "OutdoorCare", screen_fr = "Imperméable" },
  { code = "37", name = "BabyCare", screen_fr = "Bébé coton" },
  { code = "11", name = "Wool", screen_fr = "Laine" },
  { code = "48", name = "DelicatesWash", screen_fr = "Délicats" },
  { code = "3A", name = "Bedding1", screen_fr = "Draps" },
  { code = "3B", name = "Spin", screen_fr = "Essorage" },
  { code = "19", name = "RinseSpin", screen_fr = "Rinçage + essorage" },
  { code = "33", name = "EcoDrumClean", screen_fr = "Nettoyage tambour" },
  { code = "1B", name = "DiningKitchenwork", screen_fr = "Cuisine" },
  { code = "41", name = "Gardening", screen_fr = "Jardinage" },
  { code = "43", name = "HygieneCare", screen_fr = "Soin hygiène plus" },
  { code = "42", name = "ActiveSports", screen_fr = "Sport" },
  { code = "1E", name = "ActiveKids", screen_fr = "Enfants actifs" },
  { code = "1F", name = "DeskOffice", screen_fr = "Quotidien" },
  { code = "3F", name = "CottonEco", screen_fr = "e coton" },
}

-- Index → value of the washerTemperature and washerSpin capabilities (rinses
-- are the index itself, "0" to "5"). Labels: capabilities/build.py.
M.TEMPERATURES = { [0] = "none", "cold", "20", "30", "40", "60", "95" }
M.SPINS = { [0] = "rinseHold", "noSpin", "400", "800", "1200", "1400" }

local by_code, by_name = {}, {}
for _, p in ipairs(M.PROGRAMMES) do
  by_code[p.code], by_name[p.name] = p, p
end

function M.by_code(code) return code and by_code[code:upper()] end
function M.by_name(name) return name and by_name[name] end

-- Machine names, the values of the washerProgramme capability.
function M.names()
  local t = {}
  for i, p in ipairs(M.PROGRAMMES) do t[i] = p.name end
  return t
end

local function index_of(list, value)
  for i = 0, #list do
    if list[i] == value then return i end
  end
  return nil
end

-- "2F8493A5" → { code = "2F", temperature = 4, rinse = 3, spin = 5 }
function M.decode_option(value)
  if type(value) ~= "string" then return nil end
  local code, t, r, s = value:upper():match("^(%x%x)8(%x)9(%x)A(%x)$")
  if not code then return nil end
  return { code = code, temperature = tonumber(t, 16), rinse = tonumber(r, 16), spin = tonumber(s, 16) }
end

function M.encode_option(o)
  return string.format("%s8%X9%XA%X", o.code, o.temperature, o.rinse, o.spin)
end

local function bits(mask)
  local t = {}
  for i = 0, 7 do
    if (mask >> i) & 1 == 1 then t[#t + 1] = i end
  end
  return t
end

-- WM_FUN_OPT_LIST_INDOOR → code → { default = option, temperatures = {i…}, rinses = {i…}, spins = {i…} }
function M.parse_option_list(value)
  local list = {}
  if type(value) ~= "string" then return list end
  for entry in value:upper():gmatch("%x%x%x%x%x%x%x%x%x%x%x%x%x%x") do
    local b = {}
    for i = 1, 13, 2 do b[#b + 1] = tonumber(entry:sub(i, i + 1), 16) end
    local code = entry:sub(1, 2)
    list[code] = {
      default = { code = code, temperature = b[2] & 0x0F, rinse = b[4] & 0x0F, spin = b[6] & 0x0F },
      temperatures = bits(b[3]), rinses = bits(b[5]), spins = bits(b[7]),
    }
  end
  return list
end

local function values(indices, names)
  local t = {}
  for _, i in ipairs(indices) do
    local v = names and names[i] or tostring(i)
    if v then t[#t + 1] = v end
  end
  return t
end

-- Supported values of each setting for one programme, as capability values.
function M.supported(entry)
  if not entry then return { temperatures = {}, rinses = {}, spins = {} } end
  local temps = values(entry.temperatures, M.TEMPERATURES)
  if #temps == 0 then temps = { "none" } end
  return { temperatures = temps, rinses = values(entry.rinses), spins = values(entry.spins, M.SPINS) }
end

local function contains(list, v)
  for _, x in ipairs(list) do if x == v then return true end end
  return false
end

-- New COURSE_OPTION after changing one setting ("temperature" | "rinse" | "spin")
-- to a capability value; nil and a reason when the programme does not allow it.
function M.with_setting(current, entry, setting, value)
  local o = M.decode_option(current)
  if not o or not entry then return nil, "current settings unreadable" end
  local index
  if setting == "temperature" then
    index = index_of(M.TEMPERATURES, value)
    if not index or not contains(entry.temperatures, index) then return nil, "temperature not allowed: " .. tostring(value) end
  elseif setting == "spin" then
    index = index_of(M.SPINS, value)
    if not index or not contains(entry.spins, index) then return nil, "spin not allowed: " .. tostring(value) end
  elseif setting == "rinse" then
    index = tonumber(value)
    if not index or not contains(entry.rinses, index) then return nil, "rinses not allowed: " .. tostring(value) end
  else
    return nil, "unknown setting"
  end
  o[setting] = index
  return M.encode_option(o)
end

-- Readable summary of a COURSE_OPTION, for logs.
function M.describe(value)
  local o = M.decode_option(value)
  if not o then return tostring(value) end
  local p = M.by_code(o.code)
  return string.format("%s, %s °C, %d rinse(s), %s rpm", p and p.name or o.code,
    M.TEMPERATURES[o.temperature] or "?", o.rinse, M.SPINS[o.spin] or "?")
end

return M
