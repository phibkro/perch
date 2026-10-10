-- Tern 0.6.0 (0e39682) and 0.7.0 (9ca00e4), checked against their generated SDKs.
-- No cx is retained. Every timer/fetch callback receives a fresh window context.
local PRIVATE_PROTOCOL = "perch-tern-plugin"
local config = nil
local bridgeId = nil
local sequence = 0
local inspectPane = nil
local receipts = tern.json.array()
local generations = {}
local serial = 0
local running = false
local scheduled = nil
local Requests = require("./requests")
local requests = Requests.new()

local function generation(pane)
	if generations[pane] == nil then
		serial += 1
		generations[pane] = tostring(serial)
	end
	return generations[pane]
end

local function invalidate(pane)
	serial += 1
	generations[pane] = tostring(serial)
	requests:forget(pane)
end

local function clip(value, maximum)
	if type(value) ~= "string" then return "" end
	if #value <= maximum then return value end
	local boundary = utf8.offset(value, 0, maximum + 1)
	return value:sub(1, (boundary or maximum + 1) - 1)
end

local function array(value)
	return tern.json.array(type(value) == "table" and value or {})
end

local function surfaceState(cx, pane)
	local ok, surface = pcall(function()
		return cx.session:surface(pane, { root = "dock", nodes = 500, depth = 16, max_chars = 64_000 })
	end)
	if not ok or type(surface) ~= "table" or type(surface.surface) ~= "table" then
		return false, false
	end
	local native = surface.surface.role == "omp.session"
	local function ready(node, inComposer)
		if type(node) ~= "table" then return false end
		if type(node.p) == "table" and node.p.hidden == true then return false end
		inComposer = inComposer or (type(node.p) == "table" and node.p.role == "omp.editor")
		if (node.k == "editor" or node.k == "input") and type(node.p) == "table"
			and inComposer and node.p.sendable == true and node.p.readonly ~= true then return true end
		for _, child in ipairs(node.c or {}) do
			if ready(child, inComposer) then return true end
		end
		return false
	end
	-- An overlay may also contain a sendable editor. Only the live omp.session
	-- dock is the conversation composer; never answer an arbitrary modal editor.
	return native, native and (ready(surface.dock, false) or ready(surface.main, false) or ready(surface.layer, false))
end

local function capture(cx)
	local entries = array(cx.agents:list())
	local tabs = {}
	local workspaces = {}
	local hosts = {}
	for _, host in ipairs(array(cx.hosts:list())) do
		for _, pane in ipairs(host.panes or {}) do hosts[pane] = clip(host.name, 512) end
	end
	for _, session in ipairs(array(cx.session:sessions())) do
		for _, tab in ipairs(session.tabs or {}) do workspaces[tab] = clip(session.name, 512) end
	end
	for _, tab in ipairs(array(cx.session:tabs())) do tabs[tab.id] = clip(tab.name or tab.title, 512) end
	local agents = tern.json.array()
	local detail = nil
	for i, entry in ipairs(entries) do
		if i > 32 then break end
		local pane = cx.session:pane(entry.pane)
		if pane then
			local currentGeneration = generation(entry.pane)
			local native = false
			local canPrompt = false
			if entry.pane == inspectPane then native, canPrompt = surfaceState(cx, entry.pane) end
			local command = type(entry.command) == "string" and entry.command or ""
			local harness = (native or command:match("^omp[%s]*$") or command:match("^omp%s")) and "omp" or "tern"
			table.insert(agents, {
				pane = entry.pane, generation = currentGeneration,
				title = clip(pane.title, 512), cwd = clip(entry.cwd, 2048), state = entry.state,
				harness = harness,
				model = type(entry.model) == "string" and clip(entry.model, 512) or nil,
				deliveryError = type(entry.delivery_error) == "string" and clip(entry.delivery_error, 2048) or nil,
				location = { host = hosts[entry.pane], workspace = workspaces[pane.tab], tab = tabs[pane.tab], pane = tostring(entry.pane) },
			})
			if entry.pane == inspectPane then
				local source = array(cx.agents:transcript(entry.pane, { last = 64 }))
				local messages = tern.json.array()
				local truncated = #source >= 64
				local remaining = 160_000
				-- Allocate recent text first. No full transcript is stored by this plugin.
				for index = #source, 1, -1 do
					local row = source[index]
					local text = clip(row.text, math.min(64_000, math.max(0, remaining)))
					remaining -= #text
					if text ~= row.text then truncated = true end
					local tools = tern.json.array()
					for toolIndex, tool in ipairs(row.tools or {}) do
						if toolIndex > 64 then truncated = true; break end
						local output = clip(tool.text, math.min(8_000, math.max(0, remaining)))
						remaining -= #output
						if type(tool.text) == "string" and output ~= tool.text then truncated = true end
						table.insert(tools, { name = clip(tool.name, 512), target = clip(tool.target, 2048),
							status = clip(tool.status, 128), text = output })
					end
					table.insert(messages, 1, { role = row.role, text = text, tools = tools })
				end
				local notices = tern.json.array()
				local question, modal = requests:read(cx, entry.pane, currentGeneration)
				if question or modal then canPrompt = false end
				if truncated then table.insert(notices, "This is a bounded transcript preview. Older rows or long text may be omitted.") end
				if not native then table.insert(notices, "The native OMP session surface is unavailable. Return to the chat view in Tern for prompt controls.") end
				if native and not canPrompt then table.insert(notices, "The host composer is not ready. Perch does not queue a prompt in Tern.") end
				detail = { pane = entry.pane, generation = currentGeneration, messages = messages,
					canPrompt = canPrompt and entry.state ~= "exited", canInterrupt = native and entry.state ~= "exited",
					canFocus = entry.state ~= "exited",
					truncated = truncated, notices = notices, pendingQuestion = question }
			end
		end
	end
	return { protocol = PRIVATE_PROTOCOL, version = 1, bridgeId = bridgeId, sequence = sequence,
		agents = agents, detail = detail, receipts = receipts }
end

local exchange
local register

local function disconnected()
	-- A failed exchange may have carried a command or its receipt. A fresh
	-- registration never fetches the old command again, even when its effect is unknown.
	bridgeId = nil
	sequence = 0
	inspectPane = nil
	receipts = tern.json.array()
	scheduled = tern.timer(1500, function(cx) scheduled = nil; register(cx) end)
end

local function request(path, value, callback)
	local ok = pcall(function()
		tern.fetch(config.url .. path, { method = "POST", timeout_ms = 4000,
			headers = { ["Authorization"] = "Bearer " .. config.token, ["Content-Type"] = "application/json" },
			body = tern.json.encode(value) }, callback)
	end)
	if not ok then disconnected() end
end

local function dispatch(cx, command)
	local event = nil
	local ok, result = pcall(function()
		if type(command) ~= "table" or type(command.id) ~= "string" or
			type(command.pane) ~= "number" or generations[command.pane] ~= command.generation then
			error("The pane generation changed before delivery.")
		end
		local present = false
		for _, agent in ipairs(array(cx.agents:list())) do
			if agent.pane == command.pane and agent.state ~= "exited" then present = true; break end
		end
		if not present then error("The agent is no longer present.") end
		-- Focusing a live pane does not require its conversation composer to be visible.
		if command.type == "focus-session" then return end
		local native, canPrompt = surfaceState(cx, command.pane)
		if not native then error("The native OMP conversation is unavailable.") end
		if command.type == "prompt" then
			local question, modal = requests:read(cx, command.pane, command.generation)
			if not canPrompt or question or modal then error("The host composer is not ready; this prompt was not queued.") end
			if type(command.text) ~= "string" or #command.text > 400_000 or not command.text:match("%S") then
				error("Invalid prompt.")
			end
		elseif command.type == "answer" then
			event = requests:prepare(cx, command.pane, command.generation, command)
		elseif command.type ~= "interrupt" then error("Unsupported remote command.") end
	end)
	if not ok then
		return { id = command.id, status = "rejected", message = clip(tostring(result), 2048) }
	end
	-- No yield between validation and invocation: don't enter Tern's waiting
	-- queue. Once invocation begins an error cannot prove there was no effect.
	local invoked, failure = pcall(function()
		if command.type == "prompt" then cx.agents:ask(command.pane, command.text)
		elseif command.type == "answer" then cx.session:event(command.pane, event)
		elseif command.type == "focus-session" then cx.layout:focus(command.pane)
		else cx.agents:interrupt(command.pane) end
	end)
	return { id = command.id, status = invoked and "forwarded" or "unknown",
		message = invoked and "The Tern window plugin called the requested API."
			or clip("Tern API invocation failed; inspect the host before retrying. " .. tostring(failure), 2048) }
end

exchange = function(cx)
	if bridgeId == nil then return end
	sequence += 1
	local ok, frame = pcall(function() return capture(cx) end)
	if not ok then
		tern.log.warn("Perch snapshot capture failed", clip(tostring(frame), 512))
		disconnected(); return
	end
	request("/tern/exchange", frame, function(response, freshCx)
		if response.status ~= 200 or response.error then disconnected(); return end
		local decoded, value = pcall(tern.json.decode, response.body)
		if not decoded or type(value) ~= "table" or value.bridgeId ~= bridgeId or value.sequence ~= sequence then
			disconnected(); return
		end
		receipts = tern.json.array()
		inspectPane = value.inspectPane
		local commands = value.commands or {}
		-- The bridge issues at most one per exchange. A malformed batch is not executed.
		if type(commands) ~= "table" or #commands > 1 then disconnected(); return end
		for _, command in ipairs(commands) do
			if type(command) ~= "table" or type(command.id) ~= "string" then disconnected(); return end
			table.insert(receipts, dispatch(freshCx, command))
		end
		-- The bridge holds the response for the polling interval. Fetch again
		-- using this callback's fresh context; no window timer drives normal polling.
		exchange(freshCx)
	end)
end

register = function(_cx)
	request("/tern/register", { protocol = PRIVATE_PROTOCOL, version = 1 }, function(response, freshCx)
		if response.status ~= 200 or response.error then disconnected(); return end
		local ok, value = pcall(tern.json.decode, response.body)
		if not ok or type(value) ~= "table" or type(value.bridgeId) ~= "string" then disconnected(); return end
		bridgeId = value.bridgeId
		sequence = 0
		exchange(freshCx)
	end)
end

tern.on("window_start", function(cx)
	if running then return end
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read("connection.json", 16_384))
	end)
	if not ok or type(value) ~= "table" or type(value.url) ~= "string" or
		not value.url:match("^http://127%.0%.0%.1:%d+$") or type(value.token) ~= "string" or #value.token < 24 then
		tern.log.warn("Perch remote needs a private connection.json pointing to the loopback bridge; run its host setup.")
		return
	end
	config = value
	running = true
	register(cx)
end)

tern.on("command_started", function(ev, _cx) invalidate(ev.pane) end)
tern.on("command_finished", function(ev, _cx) invalidate(ev.pane) end)
tern.on("pane_closed", function(ev, _cx) generations[ev.pane] = nil; requests:forget(ev.pane) end)
