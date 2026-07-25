-- ─────────────────────────────────────────────────────────────────────────────
-- game-alert.lua  (on_post_launch event – runs when a game session starts)
-- Logs a timestamped message and toggles masking OFF so your real status shows.
-- Useful as a starting template for game-start automation.
-- ─────────────────────────────────────────────────────────────────────────────

function on_post_launch()
  local ts = os.date("%H:%M:%S")
  riot.log("[" .. ts .. "] Game started! Disabling mask for this session.")
  riot.set_masking(false)
  riot.set_status("In Game")
end

riot.log("Game-alert script loaded – waiting for game launch events.")
