-- Local protocol of Samsung Wi-Fi washers of 2013-2015 (seen on a WW10H9400EW):
-- XML messages over TLS on TCP 2878, one message per line ("\r\n"). Same
-- protocol as lib/drc.js in the Homebridge plugin, where it is documented.
--   connect   → "DRC-1.00", <Update Type="InvalidateAccount"/>
--   GetToken  → Status="Ready", then Smart Control off/on → <Update Type="GetToken" Token="…"/>
--   AuthToken → Status="Okay"; DeviceList → DUID; DeviceState → <Attr ID=… Value=…/>
--   DeviceControl WM_FUN_OPERATION = Start | Pause | Stop ("Run" → ErrorCode 210)
-- Failures come back as <Response Status="Fail" ErrorCode="…"/> without Type.

local M = {}

M.PORT = 2878
local DECL = '<?xml version="1.0" encoding="utf-8" ?>'
local READ_SLICE_S = 1

local function unescape(s)
  return (s:gsub("&quot;", '"'):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&apos;", "'"):gsub("&amp;", "&"))
end

function M.escape(s)
  return (tostring(s):gsub("&", "&amp;"):gsub('"', "&quot;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
end

local function parse_attrs(s)
  local t = {}
  for k, v in s:gmatch('([%w_:%.%-]+)%s*=%s*"([^"]*)"') do t[k] = unescape(v) end
  return t
end

-- One received line → { tag, attrs, values (Attr ID → Value), devices }, or nil
-- for the "DRC-1.00" greeting and blank lines.
function M.parse_line(line)
  local body = line:gsub("^%s*<%?xml.-%?>%s*", "")
  local tag, rest = body:match("^<([%w_:]+)(.-)/?>")
  if not tag then return nil end
  local msg = { tag = tag, attrs = parse_attrs(rest), values = {}, devices = {} }
  for a in body:gmatch("<Attr%s(.-)/?>") do
    local t = parse_attrs(a)
    if t.ID then msg.values[t.ID] = t.Value end
  end
  for a in body:gmatch("<Device%s(.-)/?>") do
    msg.devices[#msg.devices + 1] = parse_attrs(a)
  end
  return msg
end

local function is_okay(msg)
  local s = (msg.attrs.Status or ""):lower()
  return s == "okay" or s == "ok"
end
M.is_okay = is_okay

local function fail_text(msg)
  return string.format("%s%s", msg.attrs.Status or "?", msg.attrs.ErrorCode and (" " .. msg.attrs.ErrorCode) or "")
end

-- Session: one TLS connection -----------------------------------------------

local Session = {}
Session.__index = Session

-- opts: host, port, cert, key (path in the driver package or PEM), timeout,
-- and optionally socket / ssl modules (cosock ones by default).
function M.open(opts)
  local socket = opts.socket or require "cosock.socket"
  local ssl = opts.ssl or require "cosock.ssl"
  local sock, err = socket.tcp()
  if not sock then return nil, "offline: " .. tostring(err) end
  sock:settimeout(opts.timeout or 10)
  local ok
  ok, err = sock:connect(opts.host, opts.port or M.PORT)
  if not ok then
    sock:close()
    return nil, "offline: " .. tostring(err)
  end
  local tls
  tls, err = ssl.wrap(sock, {
    mode = "client",
    protocol = "any",
    verify = "none",
    options = { "all" },
    certificates = { { certificate = opts.cert, key = opts.key } },
  })
  if not tls then
    sock:close()
    return nil, "tls: " .. tostring(err)
  end
  tls:settimeout(opts.timeout or 10)
  ok, err = tls:dohandshake()
  if not ok then
    tls:close()
    return nil, "tls: " .. tostring(err)
  end
  tls:settimeout(READ_SLICE_S)
  return setmetatable({ sock = tls, inbox = {}, partial = nil, clock = opts.clock or os.time }, Session)
end

function Session:send(xml)
  local ok, err = self.sock:send(DECL .. xml .. "\r\n")
  if not ok then return nil, "offline: " .. tostring(err) end
  return true
end

-- Waits for a message matching match(msg); the others are kept for later.
function Session:next(match, timeout)
  for i, m in ipairs(self.inbox) do
    if match(m) then
      table.remove(self.inbox, i)
      return m
    end
  end
  local deadline = self.clock() + (timeout or 10)
  while true do
    local line, err, partial = self.sock:receive("*l", self.partial)
    self.partial = nil
    if line then
      local m = M.parse_line(line)
      if m then
        if match(m) then return m end
        if #self.inbox >= 50 then table.remove(self.inbox, 1) end
        self.inbox[#self.inbox + 1] = m
      end
    elseif err == "timeout" then
      if partial and #partial > 0 then self.partial = partial end
      if self.clock() >= deadline then return nil, "offline: timed out" end
    else
      return nil, "offline: " .. tostring(err)
    end
  end
end

-- Sends a request and returns the <Response> that answers it.
function Session:request(rtype, xml, command_id, timeout)
  local ok, err = self:send(xml)
  if not ok then return nil, err end
  return self:next(function(m)
    if m.tag ~= "Response" then return false end
    if m.attrs.Type == rtype then return true end
    return m.attrs.Type == nil and (command_id == nil or m.attrs.CommandID == nil or m.attrs.CommandID == command_id)
  end, timeout)
end

function Session:close()
  pcall(function() self.sock:close() end)
end

-- Washer: authenticated sessions ---------------------------------------------

local Washer = {}
Washer.__index = Washer

-- opts: as M.open, plus token.
function M.new(opts)
  return setmetatable({ opts = opts, duid = nil }, Washer)
end

-- Runs fn(session, duid) on a fresh authenticated session.
function Washer:with_session(fn)
  if not self.opts.token or self.opts.token == "" then return nil, "auth: no token" end
  local s, err = M.open(self.opts)
  if not s then return nil, err end
  local ok, res, err2 = pcall(function()
    local auth, e = s:request("AuthToken", '<Request Type="AuthToken"><User Token="' .. M.escape(self.opts.token) .. '" /></Request>')
    if not auth then return nil, e end
    if not is_okay(auth) then return nil, "auth: token refused (" .. fail_text(auth) .. ")" end
    if not self.duid then
      local list, e2 = s:request("DeviceList", '<Request Type="DeviceList" />')
      if not list then return nil, e2 end
      self.duid = list.devices[1] and list.devices[1].DUID
      if not self.duid then return nil, "error: DeviceList returns no device" end
    end
    return fn(s, self.duid)
  end)
  s:close()
  if not ok then return nil, "error: " .. tostring(res) end
  return res, err2
end

-- All attributes, as Attr ID → Value.
function Washer:read()
  return self:with_session(function(s, duid)
    local res, err = s:request("DeviceState", '<Request Type="DeviceState" DUID="' .. M.escape(duid) .. '"></Request>')
    if not res then return nil, err end
    if not is_okay(res) then return nil, "error: DeviceState " .. fail_text(res) end
    return res.values
  end)
end

-- Sets one attribute; true, or nil and the reason.
function Washer:control(id, value)
  return self:with_session(function(s, duid)
    local command_id = string.format("cmd%05d", math.random(0, 99999))
    local res, err = s:request("DeviceControl",
      '<Request Type="DeviceControl"><Control CommandID="' .. command_id .. '" DUID="' .. M.escape(duid) .. '">'
      .. '<Attr ID="' .. M.escape(id) .. '" Value="' .. M.escape(value) .. '" /></Control></Request>', command_id)
    if not res then return nil, err end
    if not is_okay(res) then return nil, "refused: " .. id .. "=" .. value .. " (" .. fail_text(res) .. ")" end
    return true
  end)
end

-- Asks for a token until someone turns Smart Control off and on again.
-- on_event(text) is told about each request. Returns the token or nil, reason.
function Washer:pair(total_s, window_s, on_event)
  total_s, window_s = total_s or 180, window_s or 30
  on_event = on_event or function() end
  local clock = self.opts.clock or os.time
  local deadline = clock() + total_s
  local s
  while clock() < deadline do
    if not s then
      local err
      s, err = M.open(self.opts)
      if not s then
        on_event("cannot connect: " .. tostring(err))
        return nil, err
      end
    end
    local res, err = s:request("GetToken", '<Request Type="GetToken" />')
    if not res then
      on_event("request failed: " .. tostring(err))
      s:close()
      s = nil
    else
      on_event("request sent (" .. tostring(res.attrs.Status) .. "): turn Smart Control off, then on again")
      local wait = math.max(1, math.min(window_s, deadline - clock()))
      local update = s:next(function(m) return m.tag == "Update" and m.attrs.Type == "GetToken" end, wait)
      if update and update.attrs.Token then
        s:close()
        return update.attrs.Token
      end
    end
  end
  if s then s:close() end
  return nil, "no token received"
end

return M
