-- Create a new color
local white = Color.new(255,255,255)

-- Main loop
while true do

	-- Draw a string on the screen
	Graphics.initBlend()
	Screen.clear()
	Graphics.debugPrint(5, 5, "Hello World!", white)
	Graphics.debugPrint(5, 25, "Press TRIANGLE to actually return to exit the application.", white)
	Graphics.termBlend()
	-- Update screen (For double buffering)
	Screen.flip()
	-- Check controls for exiting
	if Controls.check(Controls.read(), SCE_CTRL_TRIANGLE) then
		System.exit()
	end
end