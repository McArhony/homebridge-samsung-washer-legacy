-- lua test/test_drc.lua — protocol parsing, with messages copied from the real washer.
package.path = arg[0]:gsub("[^/]*$", "") .. "../src/?.lua;" .. package.path
local drc = require "drc"
local failures = 0
local function check(name, cond)
  if cond then print("ok   " .. name) else print("FAIL " .. name); failures = failures + 1 end
end

check("greeting ignored", drc.parse_line("DRC-1.00") == nil)
check("blank ignored", drc.parse_line("") == nil)

local m = drc.parse_line('<?xml version="1.0" encoding="utf-8" ?><Update Type="InvalidateAccount"/>')
check("self-closing update", m.tag == "Update" and m.attrs.Type == "InvalidateAccount")

m = drc.parse_line('<?xml version="1.0" encoding="utf-8" ?><Response Type="DeviceList" Status="Okay"><DeviceList DeviceCount="1"><Device DUID="A1B2C3D4E5F60000" GroupID="WM" ModelID="WM" /></DeviceList></Response>')
check("device list", m.tag == "Response" and drc.is_okay(m) and m.devices[1].DUID == "A1B2C3D4E5F60000")

m = drc.parse_line('<?xml version="1.0" encoding="utf-8" ?><Response Type="DeviceState" Status="Okay"><DeviceState><Device DUID="X" GroupID="WM" ModelID="WM" ><Attr ID="WM_FUN_SETTIME" Type="W" Value=""/><Attr ID="WM_FUN_OPERATION" Type="RW" Value="Start"/><Attr ID="WM_FUN_OTLEFT" Type="R" Value="138"/><Attr ID="WM_FUN_COURSE_LIST" Type="R" Value="3E/2F/2C"/></Device></DeviceState></Response>')
check("state values", m.values.WM_FUN_OPERATION == "Start" and m.values.WM_FUN_OTLEFT == "138" and m.values.WM_FUN_SETTIME == "")
check("value with slashes", m.values.WM_FUN_COURSE_LIST == "3E/2F/2C")
check("DeviceState root attrs", m.attrs.Type == "DeviceState" and m.attrs.Status == "Okay")

m = drc.parse_line('<?xml version="1.0" encoding="utf-8" ?><Response Status="Fail" ErrorCode="210" DUID="A1B2C3D4E5F60000" CommandID="cmd40774"/>')
check("type-less fail", m.tag == "Response" and m.attrs.Type == nil and m.attrs.ErrorCode == "210" and not drc.is_okay(m))

m = drc.parse_line('<?xml version="1.0" encoding="utf-8" ?><Update Type="GetToken" Status="Completed" Token="abc&amp;d"/>')
check("token unescaped", m.attrs.Token == "abc&d")

check("escape", drc.escape('a"<&>') == "a&quot;&lt;&amp;&gt;")

-- Session and Washer, on a fake TLS socket fed with real lines.
local fake_lines
local fake_socket = { tcp = function()
  return { settimeout = function() end, connect = function() return 1 end, close = function() end }
end }
local fake_ssl = { wrap = function()
  local s = { sent = {} }
  function s:settimeout() end
  function s:dohandshake() return true end
  function s:receive() local l = table.remove(fake_lines, 1); if l then return l end; return nil, "timeout", "" end
  function s:send(x) self.sent[#self.sent + 1] = x; return #x end
  function s:close() end
  return s
end }
local t = 0
local opts = { host = "h", socket = fake_socket, ssl = fake_ssl, clock = function() t = t + 1; return t end }

fake_lines = { "DRC-1.00", '<?xml version="1.0" encoding="utf-8" ?><Update Type="InvalidateAccount"/>',
  '<?xml version="1.0" encoding="utf-8" ?><Response Status="Fail" ErrorCode="210" CommandID="cmd1"/>' }
local s = drc.open(opts)
local r = s:request("DeviceControl", "<Request/>", "cmd1", 5)
check("request returns the type-less fail at once", r and r.attrs.ErrorCode == "210")
check("request sent with declaration and CRLF", s.sock.sent[1]:match('^<%?xml.-%?><Request/>\r\n$') ~= nil)

fake_lines = { '<?xml version="1.0" encoding="utf-8" ?><Update Type="Status"><Status DUID="X"><Attr ID="WM_FUN_PROGRESS" Value="Wash" /></Status></Update>',
  '<?xml version="1.0" encoding="utf-8" ?><Response Type="DeviceState" Status="Okay"><DeviceState><Device DUID="X"><Attr ID="WM_FUN_OPERATION" Value="Pause"/></Device></DeviceState></Response>' }
s = drc.open(opts)
r = s:request("DeviceState", "<Request/>", nil, 5)
check("unsolicited update skipped, kept in inbox", r and r.values.WM_FUN_OPERATION == "Pause" and #s.inbox == 1)

fake_lines = {}
s = drc.open(opts)
local none, err = s:request("DeviceState", "<Request/>", nil, 3)
check("timeout reported as offline", none == nil and err:match("^offline") ~= nil)

-- Washer: auth refused
t = 0
fake_lines = { '<?xml version="1.0" encoding="utf-8" ?><Response Type="AuthToken" Status="Fail" ErrorCode="301"/>' }
local w = drc.new({ host = "h", socket = fake_socket, ssl = fake_ssl, clock = opts.clock, token = "x" })
local v
v, err = w:read()
check("auth refused", v == nil and err:match("^auth") ~= nil)

-- Washer: full read
fake_lines = {
  '<?xml version="1.0" encoding="utf-8" ?><Response Type="AuthToken" Status="Okay"/>',
  '<?xml version="1.0" encoding="utf-8" ?><Response Type="DeviceList" Status="Okay"><DeviceList><Device DUID="D1" /></DeviceList></Response>',
  '<?xml version="1.0" encoding="utf-8" ?><Response Type="DeviceState" Status="Okay"><DeviceState><Device DUID="D1"><Attr ID="WM_FUN_COURSE" Value="Cotton"/></Device></DeviceState></Response>',
}
w = drc.new({ host = "h", socket = fake_socket, ssl = fake_ssl, clock = opts.clock, token = "x" })
v, err = w:read()
check("read", v and v.WM_FUN_COURSE == "Cotton" and w.duid == "D1")

-- Washer: pairing
fake_lines = {
  '<?xml version="1.0" encoding="utf-8" ?><Response Type="GetToken" Status="Ready"/>',
  '<?xml version="1.0" encoding="utf-8" ?><Update Type="GetToken" Status="Completed" Token="T-1"/>',
}
w = drc.new({ host = "h", socket = fake_socket, ssl = fake_ssl, clock = opts.clock })
local token = w:pair(100, 30)
check("pairing", token == "T-1")

if failures > 0 then print(failures .. " failure(s)"); os.exit(1) end
print("all tests pass")
