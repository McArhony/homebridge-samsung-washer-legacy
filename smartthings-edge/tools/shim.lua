-- Runs src/drc.lua outside the hub: cosock.socket → luasocket, cosock.ssl → luasec.
-- luasec takes certificate/key file paths at the top level, not a "certificates" list.
local socket = require "socket"
local luasec = require "ssl"

local ssl = {}
function ssl.wrap(sock, cfg)
  local params = { mode = cfg.mode, protocol = cfg.protocol, verify = cfg.verify, options = cfg.options,
    ciphers = cfg.ciphers or "DEFAULT:@SECLEVEL=0" } -- Samsung certificates are SHA-1
  local c = cfg.certificates and cfg.certificates[1]
  if c then params.certificate, params.key = c.certificate, c.key end
  return luasec.wrap(sock, params)
end

package.preload["cosock.socket"] = function() return socket end
package.preload["cosock.ssl"] = function() return ssl end
return { socket = socket, ssl = ssl }
