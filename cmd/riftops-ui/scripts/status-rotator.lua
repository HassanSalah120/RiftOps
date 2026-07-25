-- ─────────────────────────────────────────────────────────────────────────────
-- status-rotator.lua  (on_tick event – runs every engine tick)
-- Rotates your League presence status through a custom cycle.
-- Edit the messages table and interval_minutes to customize.
-- ─────────────────────────────────────────────────────────────────────────────

local messages = {
  "RiftOps: In the rift",
  "RiftOps: Grinding ranked",
  "RiftOps: Off to climb",
}

local interval_minutes = 30   -- change every 30 minutes
local idx = 1
local last_rotate = 0

function on_tick()
  local now = os.time()
  if (now - last_rotate) >= (interval_minutes * 60) then
    riot.set_status(messages[idx])
    riot.log("Status rotated to: " .. messages[idx])
    idx = (idx % #messages) + 1
    last_rotate = now
  end
end

riot.log("Status rotator loaded – rotating every " .. interval_minutes .. " min.")
