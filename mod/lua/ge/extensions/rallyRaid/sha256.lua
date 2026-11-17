-- Rally Raid: SHA-256 in plain LuaJIT (the `bit` library), for the official-event file hashes. The website hashes the
-- same bytes (the stage / roadbook file text exactly as published), so the hex strings must match byte for byte.
local bit = require('bit')
local band, bor, bxor, bnot, rshift, lshift, ror, tobit =
  bit.band, bit.bor, bit.bxor, bit.bnot, bit.rshift, bit.lshift, bit.ror, bit.tobit

local K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2 }
for i = 1, 64 do K[i] = tobit(K[i]) end

local M = {}
function M.hex(s)
  local H = { tobit(0x6a09e667), tobit(0xbb67ae85), tobit(0x3c6ef372), tobit(0xa54ff53a),
              tobit(0x510e527f), tobit(0x9b05688c), tobit(0x1f83d9ab), tobit(0x5be0cd19) }
  local len = #s
  local bits = len * 8
  -- padding: 0x80, zeros, then the bit length as 64-bit big-endian
  local pad = 64 - ((len + 9) % 64)
  if pad == 64 then pad = 0 end
  local hi = math.floor(bits / 4294967296)
  local lo = bits % 4294967296
  local tail = '\128' .. string.rep('\0', pad) .. string.char(
    rshift(hi, 24) % 256, rshift(hi, 16) % 256, rshift(hi, 8) % 256, hi % 256,
    math.floor(lo / 16777216) % 256, math.floor(lo / 65536) % 256, math.floor(lo / 256) % 256, lo % 256)
  local W = {}
  local byte = string.byte
  local function block(str, p)
    for i = 0, 15 do
      local a, b, c, d = byte(str, p + i * 4, p + i * 4 + 3)
      W[i] = bor(lshift(a, 24), lshift(b, 16), lshift(c, 8), d)
    end
    for i = 16, 63 do
      local w15, w2 = W[i - 15], W[i - 2]
      local s0 = bxor(ror(w15, 7), ror(w15, 18), rshift(w15, 3))
      local s1 = bxor(ror(w2, 17), ror(w2, 19), rshift(w2, 10))
      W[i] = tobit(W[i - 16] + s0 + W[i - 7] + s1)
    end
    local a, b, c, d, e, f, g, h = H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]
    for i = 0, 63 do
      local S1 = bxor(ror(e, 6), ror(e, 11), ror(e, 25))
      local ch = bxor(band(e, f), band(bnot(e), g))
      local t1 = tobit(h + S1 + ch + K[i + 1] + W[i])
      local S0 = bxor(ror(a, 2), ror(a, 13), ror(a, 22))
      local maj = bxor(band(a, b), band(a, c), band(b, c))
      local t2 = tobit(S0 + maj)
      h, g, f, e, d, c, b, a = g, f, e, tobit(d + t1), c, b, a, tobit(t1 + t2)
    end
    H[1], H[2], H[3], H[4] = tobit(H[1] + a), tobit(H[2] + b), tobit(H[3] + c), tobit(H[4] + d)
    H[5], H[6], H[7], H[8] = tobit(H[5] + e), tobit(H[6] + f), tobit(H[7] + g), tobit(H[8] + h)
  end
  local full = len - (len % 64)
  for p = 1, full, 64 do block(s, p) end
  local rest = s:sub(full + 1) .. tail
  for p = 1, #rest, 64 do block(rest, p) end
  local out = {}
  for i = 1, 8 do out[i] = bit.tohex(H[i], 8) end
  return table.concat(out)
end
return M
