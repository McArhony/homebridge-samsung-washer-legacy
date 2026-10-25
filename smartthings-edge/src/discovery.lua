-- Finds the washer on the hub's /24 network: these washers answer neither
-- SSDP nor mDNS, so every address is tried on TCP 2878, then the ones that
-- answer are checked with the Samsung certificate (the washer then sends
-- <Update Type="InvalidateAccount"/>).

local cosock = require "cosock"
local socket = require "cosock.socket"
local log = require "log"
local drc = require "drc"

local M = {}

local CONNECT_TIMEOUT_S = 1.5
local SCAN_TIMEOUT_S = 90
-- The hub limits open sockets: a few workers share the 254 addresses.
local WORKERS = 12

-- Local IPv4 of the hub (the WeMo driver's trick: no packet is sent).
function M.hub_ip(driver)
  local ip = driver.environment_info and driver.environment_info.hub_ipv4
  if ip then return ip end
  local s = socket.udp()
  s:setpeername("192.168.0.1", 9)
  local local_ip = s:getsockname()
  s:close()
  return local_ip
end

local function port_open(ip)
  local s = socket.tcp()
  if not s then return false end
  s:settimeout(CONNECT_TIMEOUT_S)
  local ok = s:connect(ip, drc.PORT)
  s:close()
  return ok ~= nil
end

local function is_washer(ip, cert, key)
  local session = drc.open({ host = ip, cert = cert, key = key, timeout = 5 })
  if not session then return false end
  local hello = session:next(function(m) return m.tag == "Update" and m.attrs.Type == "InvalidateAccount" end, 4)
  session:close()
  return hello ~= nil
end

-- Returns the washer's IP address, or nil.
function M.find(driver, cert, key)
  local hub = M.hub_ip(driver)
  local prefix = hub and hub:match("^(%d+%.%d+%.%d+)%.%d+$")
  if not prefix then
    log.warn("discovery: unknown hub address, set the washer's IP in the device settings")
    return nil
  end
  log.info(string.format("discovery: scanning %s.1-254 on port %d", prefix, drc.PORT))
  local open, next_host, running = {}, 1, WORKERS
  for w = 1, WORKERS do
    cosock.spawn(function()
      while next_host <= 254 do
        local ip = prefix .. "." .. next_host
        next_host = next_host + 1
        -- An error in a spawned task would stop the whole driver.
        local ok, found = pcall(port_open, ip)
        if ok and found and ip ~= hub then open[#open + 1] = ip end
      end
      running = running - 1
    end, "scan worker " .. w)
  end
  local waited = 0
  while running > 0 and waited < SCAN_TIMEOUT_S do
    socket.sleep(0.5)
    waited = waited + 0.5
  end
  for _, ip in ipairs(open) do
    local ok, washer = pcall(is_washer, ip, cert, key)
    if ok and washer then
      log.info("discovery: washer found at " .. ip)
      return ip
    end
  end
  log.info("discovery: no washer answering on port " .. drc.PORT .. " (is it on, with Smart Control on?)")
  return nil
end

return M
