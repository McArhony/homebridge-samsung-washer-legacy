-- SmartThings Edge driver for Samsung Wi-Fi washers of 2013-2015 that
-- SmartThings does not support (e.g. WW10H9400EW), through their local XML
-- protocol on TCP 2878 (see drc.lua). Programmes and settings: see course.lua.
--
-- The Samsung certificate (ac14k_m.pem / .key) and, optionally, an existing
-- token are packaged in src/secrets/, which is not in git. Without a token,
-- the "Pair now" preference asks the washer for one.

local capabilities = require "st.capabilities"
local Driver = require "st.driver"
local log = require "log"
local cosock = require "cosock"
local drc = require "drc"
local discovery = require "discovery"
local course = require "course"

local CERT = "secrets/ac14k_m.pem"
local KEY = "secrets/ac14k_m.key"
local DNI = "samsung-washer-drc"
-- Consecutive failed polls before looking for the washer again (its DHCP
-- address may have changed), when no address is set in the settings.
local RESCAN_AFTER_FAILURES = 10

local washerOperatingState = capabilities.washerOperatingState
local remoteControlStatus = capabilities.remoteControlStatus
-- Own capabilities, translated in the app (capabilities/build.py): the
-- Samsung "custom.*" ones are not shown for third-party drivers.
local NS = "perfectforest07855"
local programmeCap = capabilities[NS .. ".washerProgramme"]
local temperatureCap = capabilities[NS .. ".washerTemperature"]
local spinCap = capabilities[NS .. ".washerSpin"]
local rinseCap = capabilities[NS .. ".washerRinse"]
local remainingCap = capabilities[NS .. ".washerRemainingTime"]
local dispenserCap = capabilities[NS .. ".washerDispenser"]
local alertsCap = capabilities[NS .. ".washerAlerts"]
local childLockCap = capabilities[NS .. ".washerChildLock"]

-- Machine values → capability values for the dispenser, alerts and child lock.
local ON_OFF = { enable = "enabled", disable = "disabled", notused = "unavailable" }
local LEVELS = { normal = "normal", low = "low", empty = "empty" }
local function lower(v) return (v or ""):lower() end
local function on_off(v) return ON_OFF[lower(v)] or "unavailable" end
local function level(v) return LEVELS[lower(v)] or "unknown" end
local function alert(v) return lower(v) == "on" and "alert" or "ok" end

-- A stop counts as the end of a cycle only when it was nearly over, not a
-- cancel or a Wi-Fi drop; "finish" then stays until the next start.
local END_THRESHOLD_MIN = 5
-- "Start" without any phase for this long counts as waiting, not washing.
local WAITING_AFTER_S = 60

-- WM_FUN_PROGRESS → washerJobState
local JOB_STATES = {
  weightsensing = "weightSensing", prewash = "preWash", wash = "wash", rinse = "rinse",
  spin = "spin", drying = "drying", cooling = "cooling", airwash = "airWash",
  wrinkleprevent = "wrinklePrevent", ["end"] = "finish", finish = "finish", complete = "finish",
  delaywash = "delayWash", reservation = "delayWash",
}

-- SmartThings machine state → WM_FUN_OPERATION (tried on the real machine)
local OPERATION_VALUES = { run = "Start", pause = "Pause", stop = "Stop" }

-- secrets/token.lua (optional) returns the token as a string.
local function packaged_token()
  local ok, token = pcall(require, "secrets.token")
  if ok and type(token) == "string" and token ~= "" then return token end
  return nil
end

local function token_for(device)
  return device:get_field("token") or packaged_token()
end

-- Address set in the settings, else the one found by discovery.
local function washer_ip(device)
  local ip = device.preferences.ipAddress
  if ip and ip:match("^%d+%.%d+%.%d+%.%d+$") then return ip end
  return device:get_field("ip")
end

local function washer_for(device)
  local ip = washer_ip(device)
  if not ip then return nil end
  local washer = device:get_field("washer")
  local token = token_for(device)
  if not washer or washer.opts.host ~= ip or washer.opts.token ~= token then
    washer = drc.new({ host = ip, cert = CERT, key = KEY, token = token, timeout = 10 })
    device:set_field("washer", washer)
  end
  return washer
end

local function machine_state(operation)
  local op = (operation or ""):lower()
  if op == "start" or op == "run" then return "run" end
  if op == "pause" then return "pause" end
  return "stop"
end

local function job_state(progress)
  if not progress or progress == "" or progress == "NULL" then return "none" end
  return JOB_STATES[progress:lower()] or "none"
end

local function iso8601(t)
  return os.date("!%Y-%m-%dT%H:%M:%SZ", t)
end

-- Emits only what changed since the last poll (lists included).
local function emit_changed(device, key, value, event)
  local fingerprint = type(value) == "table" and table.concat(value, "|") or tostring(value)
  local fields = device:get_field("emitted") or {}
  if fields[key] == fingerprint then return end
  fields[key] = fingerprint
  device:set_field("emitted", fields)
  device:emit_event(event)
end

local function emit_settings(device, v)
  local list = course.parse_option_list(v.WM_FUN_OPT_LIST_INDOOR)
  device:set_field("option_list", list)
  device:set_field("course_option", v.WM_FUN_COURSE_OPTION)

  local names = course.names()
  emit_changed(device, "programmes", names, programmeCap.supportedProgrammes(names))
  local o = course.decode_option(v.WM_FUN_COURSE_OPTION)
  local programme = (o and course.by_code(o.code)) or course.by_name(v.WM_FUN_COURSE)
  if programme then emit_changed(device, "programme", programme.name, programmeCap.programme(programme.name)) end
  if not o then return end

  local s = course.supported(list[o.code])
  emit_changed(device, "temps", s.temperatures, temperatureCap.supportedTemperatures(s.temperatures))
  emit_changed(device, "spins", s.spins, spinCap.supportedSpins(s.spins))
  emit_changed(device, "rinses", s.rinses, rinseCap.supportedRinses(s.rinses))
  local temp = course.TEMPERATURES[o.temperature] or "none"
  emit_changed(device, "temp", temp, temperatureCap.temperature(temp))
  local spin = course.SPINS[o.spin] or "rinseHold"
  emit_changed(device, "spin", spin, spinCap.spin(spin))
  local rinse = tostring(math.min(o.rinse, 5))
  emit_changed(device, "rinse", rinse, rinseCap.rinse(rinse))
end

local function track_finish(device, state, job, left)
  if state == "run" and job ~= "delayWash" then
    device:set_field("was_running", true, { persist = true })
    device:set_field("last_left", left, { persist = true })
    device:set_field("finished", false, { persist = true })
  elseif state == "stop" and device:get_field("was_running") then
    local last = device:get_field("last_left")
    if job == "finish" or (last and last <= END_THRESHOLD_MIN) then
      device:set_field("finished", true, { persist = true })
      device.log.info("cycle finished")
    end
    device:set_field("was_running", false, { persist = true })
  end
  if state == "stop" and device:get_field("finished") then return "finish" end
  return job
end

local function emit_extras(device, v)
  local auto_detergent, auto_softener = on_off(v.WM_FUN_AUTO_DETERGENT), on_off(v.WM_FUN_AUTO_SOFTENER)
  emit_changed(device, "autoDetergent", auto_detergent, dispenserCap.autoDetergent(auto_detergent))
  emit_changed(device, "autoSoftener", auto_softener, dispenserCap.autoSoftener(auto_softener))
  local detergent, softener = level(v.WM_FUN_DETERGENT_INFO), level(v.WM_FUN_SOFTENER_INFO)
  emit_changed(device, "detergentLevel", detergent, dispenserCap.detergentLevel(detergent))
  emit_changed(device, "softenerLevel", softener, dispenserCap.softenerLevel(softener))
  local drawer = lower(v.WM_FUN_DISPENSER_OPEN) == "open" and "open" or "closed"
  emit_changed(device, "drawer", drawer, dispenserCap.drawer(drawer))

  local drum, filter = alert(v.WM_FUN_DRUM_CLEAN), alert(v.WM_FUN_FILTER_ALARM)
  emit_changed(device, "drumClean", drum, alertsCap.drumClean(drum))
  emit_changed(device, "filter", filter, alertsCap.filter(filter))
  local hot, fault = alert(v.WM_FUN_HOT_WARNING), alert(v.WM_FUN_DISPENSER_ABNORMAL)
  emit_changed(device, "hotDoor", hot, alertsCap.hotDoor(hot))
  emit_changed(device, "dispenserFault", fault, alertsCap.dispenserFault(fault))
  local error_code = (v.WM_FUN_ERROR and v.WM_FUN_ERROR ~= "") and v.WM_FUN_ERROR or "Normal"
  emit_changed(device, "error", error_code, alertsCap.error(error_code))

  local lock = lower(v.WM_FUN_CHILD_LOCK) == "enable" and "enabled" or "disabled"
  emit_changed(device, "childLock", lock, childLockCap.childLock(lock))
end

local function emit_state(device, v)
  local state = machine_state(v.WM_FUN_OPERATION)
  device:emit_event(washerOperatingState.machineState(state))
  local job = job_state(v.WM_FUN_PROGRESS)
  if job == "none" and v.WM_FUN_PROGRESS and v.WM_FUN_PROGRESS ~= "NULL" then
    log.info(string.format("unknown phase: %s", v.WM_FUN_PROGRESS))
  end
  local left_now = tonumber(v.WM_FUN_OTLEFT) or 0
  job = track_finish(device, state, job, left_now)
  emit_changed(device, "job", job, washerOperatingState.washerJobState(job))

  -- Started but not washing (seen with Smart Control on: the washer holds a
  -- remote start without any phase until Smart Control is turned off).
  local waiting = false
  if state == "run" and (v.WM_FUN_PROGRESS == nil or v.WM_FUN_PROGRESS == "NULL") then
    local since = device:get_field("waiting_since") or os.time()
    device:set_field("waiting_since", since)
    waiting = os.time() - since >= WAITING_AFTER_S
    if waiting and not device:get_field("waiting_logged") then
      device:set_field("waiting_logged", true)
      device.log.warn("started but not washing: check the washer's screen (turning Smart Control off releases it)")
    end
  else
    device:set_field("waiting_since", nil)
    device:set_field("waiting_logged", nil)
  end

  local remaining = state == "stop" and 0 or left_now
  emit_changed(device, "remaining", remaining, remainingCap.remainingTime({ value = remaining, unit = "min" }))
  local text
  if state == "stop" then text = job == "finish" and "0:00" or "--:--"
  elseif waiting then text = "waiting…"
  else text = string.format("%d:%02d", remaining // 60, remaining % 60) end
  emit_changed(device, "remainingStr", text, remainingCap.remainingTimeStr(text))

  -- End time: recomputed only when the remaining time or the state really
  -- changes, so it does not drift while the washer holds or pauses.
  local key = string.format("%s/%s/%s", state, tostring(remaining), tostring(waiting))
  if key ~= device:get_field("finish_key") then
    device:set_field("finish_key", key)
    local finish = os.time()
    if state == "run" and not waiting then finish = finish + remaining * 60 end
    device:emit_event(washerOperatingState.completionTime(iso8601(finish)))
  end

  local smart = (v.WM_FUN_SMARTCONTROL or ""):lower() == "on"
  device:emit_event(remoteControlStatus.remoteControlEnabled(smart and "true" or "false"))

  emit_settings(device, v)
  emit_extras(device, v)
end

local refresh

local function find_washer(driver, device)
  if device:get_field("scanning") then return end
  device:set_field("scanning", true)
  cosock.spawn(function()
    local ok, ip = pcall(discovery.find, driver, CERT, KEY)
    if not ok then
      device.log.warn("discovery failed: " .. tostring(ip))
      ip = nil
    end
    device:set_field("scanning", false)
    if ip then
      device:set_field("ip", ip, { persist = true })
      device:set_field("failures", 0)
      refresh(driver, device)
    end
  end, "discovery " .. device.id)
end

refresh = function(driver, device)
  local washer = washer_for(device)
  if not washer then
    device:offline()
    find_washer(driver, device)
    return
  end
  local values, err = washer:read()
  if not values then
    local failures = (device:get_field("failures") or 0) + 1
    device:set_field("failures", failures)
    if failures >= RESCAN_AFTER_FAILURES and not device.preferences.ipAddress then
      device:set_field("failures", 0)
      find_washer(driver, device)
    end
    if err and err:match("^auth") then
      device.log.warn("access refused: " .. err .. " — turn on \"Pair now\" in the device settings")
    else
      device.log.info("washer unreachable: " .. tostring(err))
    end
    device:offline()
    return
  end
  device:set_field("failures", 0)
  device:online()
  emit_state(device, values)
end

local function schedule_poll(driver, device)
  local timer = device:get_field("poll_timer")
  if timer then device.thread:cancel_timer(timer) end
  local seconds = tonumber(device.preferences.pollSeconds) or 30
  timer = device.thread:call_on_schedule(seconds, function() refresh(driver, device) end, "poll")
  device:set_field("poll_timer", timer)
end

local function pair(driver, device)
  if device:get_field("pairing") then return end
  device:set_field("pairing", true)
  cosock.spawn(function()
    local ip = washer_ip(device)
    if not ip then
      device:set_field("pairing", false)
      device.log.warn("pairing: washer not found yet — turn Smart Control on and wait a minute")
      return
    end
    local washer = drc.new({ host = ip, cert = CERT, key = KEY, timeout = 10 })
    local token, err = washer:pair(180, 30, function(text) device.log.info("pairing: " .. text) end)
    device:set_field("pairing", false)
    if token then
      device:set_field("token", token, { persist = true })
      device.log.info("pairing done, token saved")
      refresh(driver, device)
    else
      device.log.warn("pairing: " .. tostring(err))
    end
  end, "pair " .. device.id)
end

local function set_machine_state(driver, device, command)
  local wanted = command.args.state
  local value = OPERATION_VALUES[wanted]
  if not value then return end
  local ok, err = washer_for(device):control("WM_FUN_OPERATION", value)
  if not ok then
    device.log.warn(string.format("command %s refused: %s", value, tostring(err)))
  end
  -- An "Okay" means accepted, not applied: read back.
  device.thread:call_with_delay(3, function() refresh(driver, device) end)
end

-- Programme and settings: one COURSE_OPTION write, without starting.
local function write_option(driver, device, value, what)
  local ok, err = washer_for(device):control("WM_FUN_COURSE_OPTION", value)
  if ok then
    device.log.info(string.format("%s: %s", what, course.describe(value)))
  else
    device.log.warn(string.format("%s refused (%s) — is Smart Control on and the washer stopped?", what, tostring(err)))
  end
  device.thread:call_with_delay(2, function() refresh(driver, device) end)
end

local function set_programme(driver, device, command)
  local programme = course.by_name(command.args.value)
  local list = device:get_field("option_list") or {}
  local entry = programme and list[programme.code]
  if not entry then
    device.log.warn("unknown programme: " .. tostring(command.args.value))
    return
  end
  write_option(driver, device, course.encode_option(entry.default), "programme")
end

local function setting_handler(setting)
  return function(driver, device, command)
    local value = command.args.value
    local current = device:get_field("course_option")
    local o = course.decode_option(current)
    local list = device:get_field("option_list") or {}
    local new, err = course.with_setting(current, o and list[o.code], setting, value)
    if not new then
      device.log.warn(err)
      refresh(driver, device) -- puts the previous value back in the app
      return
    end
    write_option(driver, device, new, setting)
  end
end

-- Dispenser and child lock: one attribute, "enabled" → Enable, "disabled" → Disable.
local function toggle_handler(attribute, what)
  return function(driver, device, command)
    local value = command.args.value == "enabled" and "Enable" or "Disable"
    local washer, ok, err = washer_for(device), nil, "washer not found yet"
    if washer then ok, err = washer:control(attribute, value) end
    if ok then
      device.log.info(string.format("%s: %s", what, value))
    else
      device.log.warn(string.format("%s refused (%s) — is Smart Control on?", what, tostring(err)))
    end
    device.thread:call_with_delay(2, function() refresh(driver, device) end)
  end
end

local function device_init(driver, device)
  device:emit_event(washerOperatingState.supportedMachineStates({ "run", "pause", "stop" }))
  refresh(driver, device)
  schedule_poll(driver, device)
  if not token_for(device) then
    device.log.warn("no token: turn on \"Pair now\" in the device settings")
  end
end

local function info_changed(driver, device, event, args)
  local old = args.old_st_store.preferences or {}
  local new = device.preferences
  if new.pairNow and not old.pairNow then pair(driver, device) end
  if new.ipAddress ~= old.ipAddress or new.pollSeconds ~= old.pollSeconds then
    refresh(driver, device)
    schedule_poll(driver, device)
  end
end

-- "Scan nearby" in the app: the device is created only when a washer answers,
-- and it then looks for it again by itself (see refresh).
local function discovery_handler(driver, opts, should_continue)
  for _, device in ipairs(driver:get_devices()) do
    if device.device_network_id == DNI then return end
  end
  if not discovery.find(driver, CERT, KEY) then return end
  driver:try_create_device({
    type = "LAN",
    device_network_id = DNI,
    label = "Washer",
    profile = "samsung-washer-drc",
    manufacturer = "Samsung",
    model = "WW10H9400EW",
    vendor_provided_label = "Samsung washer (Smart Control)",
  })
end

local driver = Driver("samsung-washer-legacy", {
  discovery = discovery_handler,
  lifecycle_handlers = {
    init = device_init,
    infoChanged = info_changed,
  },
  capability_handlers = {
    [washerOperatingState.ID] = {
      [washerOperatingState.commands.setMachineState.NAME] = set_machine_state,
    },
    [programmeCap.ID] = {
      [programmeCap.commands.setProgramme.NAME] = set_programme,
    },
    [temperatureCap.ID] = {
      [temperatureCap.commands.setTemperature.NAME] = setting_handler("temperature"),
    },
    [spinCap.ID] = {
      [spinCap.commands.setSpin.NAME] = setting_handler("spin"),
    },
    [rinseCap.ID] = {
      [rinseCap.commands.setRinse.NAME] = setting_handler("rinse"),
    },
    [dispenserCap.ID] = {
      [dispenserCap.commands.setAutoDetergent.NAME] = toggle_handler("WM_FUN_AUTO_DETERGENT", "auto detergent"),
      [dispenserCap.commands.setAutoSoftener.NAME] = toggle_handler("WM_FUN_AUTO_SOFTENER", "auto softener"),
    },
    [childLockCap.ID] = {
      [childLockCap.commands.setChildLock.NAME] = toggle_handler("WM_FUN_CHILD_LOCK", "child lock"),
    },
    [capabilities.refresh.ID] = {
      [capabilities.refresh.commands.refresh.NAME] = refresh,
    },
  },
})

log.info("Starting the Samsung Washer Legacy driver")
driver:run()
