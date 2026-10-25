-- lua tools/live_read.lua <ip> <folder with ac14k_m.pem, ac14k_m.key, token>
-- Read only: prints the washer's state.
package.path = arg[0]:gsub("[^/]*$", "") .. "../src/?.lua;" .. arg[0]:gsub("[^/]*$", "") .. "?.lua;" .. package.path
require "shim"
local drc = require "drc"
local ip, dir = arg[1], arg[2]
local token = io.open(dir .. "/token"):read("*l")
local w = drc.new({ host = ip, cert = dir .. "/ac14k_m.pem", key = dir .. "/ac14k_m.key", token = token, timeout = 8 })
local values, err = w:read()
if not values then print("FAILED", err) os.exit(1) end
print("DUID", w.duid)
for _, k in ipairs({ "WM_FUN_OPERATION", "WM_FUN_PROGRESS", "WM_FUN_OTLEFT", "WM_FUN_COURSE", "WM_FUN_SMARTCONTROL", "WM_FUN_COURSE_OPTION" }) do
  print(k, values[k])
end
