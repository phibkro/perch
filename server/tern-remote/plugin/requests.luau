-- Bounded, semantic OMP decisions. The phone never supplies a TSP event or node id.
-- Request ids/revisions are local view identities; the current OMP component id
-- and complete displayed decision are checked again before the one event write.
local Requests = {}
Requests.__index = Requests

local MAX_TEXT = 60_000
local MAX_OPTIONS = 64

local function array(value)
	return tern.json.array(type(value) == "table" and value or {})
end

local function clip(value, maximum)
	if type(value) ~= "string" then return "" end
	if #value <= maximum then return value end
	local boundary = utf8.offset(value, 0, maximum + 1)
	return value:sub(1, (boundary or maximum + 1) - 1)
end

local function plain(value)
	if type(value) == "string" then return value end
	if type(value) ~= "table" then return "" end
	local parts = {}
	for _, span in ipairs(value) do
		if type(span) == "table" and type(span.t) == "string" then table.insert(parts, span.t)
		elseif type(span) == "string" then table.insert(parts, span) end
	end
	return table.concat(parts)
end

local function props(node)
	return type(node) == "table" and type(node.p) == "table" and node.p or {}
end

local function walk(node, visit)
	if type(node) ~= "table" then return end
	if props(node).hidden == true then return end
	visit(node)
	for _, child in ipairs(node.c or {}) do walk(child, visit) end
end

local function find(node, predicate)
	local found = nil
	walk(node, function(current) if found == nil and predicate(current) then found = current end end)
	return found
end

local function role(node, name)
	return find(node, function(current) return props(current).role == name end)
end

local function text(node)
	local parts = {}
	walk(node, function(current)
		if current.k == "md" or current.k == "text" or current.k == "code" or current.k == "ansi" then
			local p = props(current)
			local value = plain(p.text or p.spans)
			if value ~= "" then table.insert(parts, value) end
		end
	end)
	return table.concat(parts, "\n\n")
end

-- Tern marks omitted nodes with `more`. Also reject a decision near its text
-- read budget: the SDK caps strings without an independent full-content hash.
-- Count every scalar, including labels, so clipped content cannot become an
-- answerable approval.
local function complete(value, maximum)
	local bytes = 0
	local capped = false
	local function count(item, depth)
		if depth > 64 then capped = true; return end
		if type(item) == "string" then bytes += #item
		elseif type(item) == "table" then
			if type(item.more) == "number" and item.more > 0 then capped = true end
			for _, child in pairs(item) do count(child, depth + 1) end
		end
	end
	count(value, 0)
	return not capped and bytes < maximum
end

local function question(category, title, prompt)
	return { kind = "choice", category = category, title = clip(title:gsub("[%z\1-\31\127]", " "), 1024),
		prompt = clip(prompt, MAX_TEXT), options = tern.json.array(), actionable = true }
end

local function blocked(q, notice)
	q.actionable = false
	q.notice = notice
	return q
end

local function addOptions(q, target, picker)
	local source = picker and props(target).items or target.c
	if type(source) ~= "table" or #source == 0 or #source > MAX_OPTIONS then
		return blocked(q, "This host decision has an unsupported number of options. Answer it in Tern.")
	end
	local seen = {}
	local enabled = false
	for i, option in ipairs(source) do
		local p = picker and option or props(option)
		local label = plain(p.label)
		local detail = plain(p.detail)
		if type(option.id) ~= "string" or #option.id > 256 or option.id == "" or seen[option.id]
			or label == "" or label:match("[%z\1-\31\127]") or #label > 1024 or #detail > 4096 or (not picker and option.k ~= "item") then
			return blocked(q, "This host decision contains an unsupported option. Answer it in Tern.")
		end
		seen[option.id] = true
		if p.disabled ~= true then enabled = true end
		-- A small opaque choice id maps to the exact current host item id privately.
		table.insert(q.options, { id = tostring(i), label = label,
			description = detail ~= "" and detail or nil, disabled = p.disabled == true or nil })
	end
	if not enabled then blocked(q, "The host has no enabled choices for this request.") end
	return q
end

local function isOptionsPicker(node)
	local p = props(node)
	if node.k ~= "picker" or type(node.id) ~= "string" or not node.id:match("^[a-z0-9]+%.%^?picker$")
		or p.noun ~= "options" or p.preview ~= "none" or p.layout ~= "rows" then return false end
	local confirm = false
	local close = false
	for _, action in ipairs(p.actions or {}) do
		if action.id == "confirm" and action.label == "Select" then confirm = true
		elseif action.id == "close" then close = true
		else return false end
	end
	return confirm and close and p.tabs == nil and p.strip == nil and p.scope == nil
end

local function extract(surface)
	if type(surface) ~= "table" or type(surface.surface) ~= "table" or surface.surface.role ~= "omp.session" then return nil end
	local candidates = {}
	for _, region in ipairs({ surface.layer or {}, surface.dock or {}, surface.main or {} }) do
		walk(region, function(node)
			local p = props(node)
			if p.role == "omp.overlay.planReview" or p.role == "omp.overlay.hook-select"
				or p.role == "omp.overlay.hook-input" or p.role == "omp.overlay.hook-editor" or isOptionsPicker(node) then
				table.insert(candidates, node)
			end
		end)
	end
	if #candidates == 0 then return nil end
	-- Multiple decisions/overlays require the owner UI's focus policy, which this
	-- small adapter does not reproduce. Never pick whichever candidate came first.
	local root = candidates[1]
	local p = props(root)
	local category = p.role == "omp.overlay.planReview" and "plan" or "question"
	local fullTitle = plain(p.head or p.title)
	local q = question(category, fullTitle, "")
	local target
	local picker = isOptionsPicker(root)
	if p.role == "omp.overlay.hook-input" or p.role == "omp.overlay.hook-editor" then
		q.prompt = clip(text(root), MAX_TEXT)
		blocked(q, "This OMP editor does not support an atomic remote answer. Complete it in Tern.")
	elseif category == "plan" then
		q.prompt = text(role(root, "omp.plan.prompt"))
		local body = role(root, "omp.plan.body")
		q.document = { title = clip(q.title ~= "" and q.title or "Plan", 512),
			content = clip(text(body), MAX_TEXT), format = "markdown" }
		target = role(root, "omp.plan.options")
		local strategy = role(root, "omp.plan.strategy")
		if strategy then
			local sp = props(strategy)
			for _, option in ipairs(sp.items or {}) do
				if option.id == sp.active then q.prompt ..= "\n\nExecution strategy: " .. plain(option.label) end
			end
		end
		local strategyDetail = find(root, function(node) return type(node.id) == "string" and node.id:match("%.sliderDetail$") ~= nil end)
		if strategyDetail then q.prompt ..= "\n\n" .. text(strategyDetail) end
		local choosingAnnotation = find(root, function(node)
			return type(node.id) == "string" and (node.id:match("%.chooser$") ~= nil or node.id:match("%.chooserHead$") ~= nil)
		end)
		if body == nil or target == nil or target.k ~= "list" or role(root, "omp.plan.feedback") or choosingAnnotation then
			blocked(q, "Finish the current plan edit or submission in Tern before answering from Perch.")
		end
	elseif picker then
		q.prompt = plain(p.subtitle)
		target = root
		if type(p.current) == "table" or (type(p.query) == "string" and p.query ~= "") or p.order ~= nil then
			blocked(q, "Filtered or multiple-choice host requests must be answered in Tern.")
		end
	else
		q.prompt = text(find(root, function(node) return type(node.id) == "string" and node.id:match("%.detail$") ~= nil end))
		target = find(root, function(node) return node.k == "list" and type(node.id) == "string" and node.id:match("%.list$") ~= nil end)
		if find(root, function(node) return node.k == "elapsed" or node.k == "tabs" end) then
			blocked(q, "Timed or multi-part host requests must be answered in Tern.")
		end
		if target and type(props(target).filter) == "string" and props(target).filter ~= "" then
			blocked(q, "Filtered host requests must be answered in Tern.")
		end
	end
	if q.title == "" then q.title = category == "plan" and "Review plan" or "Host request" end
	-- A title can contain approval details. Preserve its complete content in
	-- the body when it cannot fit the protocol's single-line title field.
	if #fullTitle > 1024 or fullTitle:match("[%z\1-\31\127]") then
		q.title = category == "plan" and "Review plan" or "Host request"
		q.prompt = fullTitle .. "\n\n" .. q.prompt
	end
	if #q.prompt > MAX_TEXT then
		q.prompt = clip(q.prompt, MAX_TEXT)
		blocked(q, "The complete host request exceeds Perch's preview limit. Review and answer it in Tern.")
	end
	if target then addOptions(q, target, picker) else blocked(q, q.notice or "This host request needs its Tern controls.") end
	if #q.options == 2 and q.options[1].label == "Approve" and q.options[2].label == "Deny" then q.category = "approval" end
	-- The fallback renderer marks multi-select rows with theme glyphs rather
	-- than semantic state. Only its verified unmarked approval pair is safe.
	if p.role == "omp.overlay.hook-select" and q.category ~= "approval" then
		blocked(q, "This fallback selector needs the host's selection controls. Answer it in Tern.")
	end
	if #candidates ~= 1 then blocked(q, "More than one host decision is open. Resolve it in Tern.") end
	-- A different modal can cover a still-mounted plan. A containing overlay is
	-- ordinary dialog chrome; an independent overlay must keep control on host.
	walk(surface.layer, function(node)
		if (node.k == "picker" or (node.k == "overlay" and props(node).modal == true)) and node ~= root
			and not find(node, function(child) return child == root end)
			and not find(root, function(child) return child == node end) then
			blocked(q, "Another host dialog is open above this request. Answer it in Tern.")
		end
	end)
	if not complete(surface, MAX_TEXT) or not complete(root, MAX_TEXT) then
		blocked(q, "The host decision exceeds Perch's complete-preview limit. Review and answer it in Tern.")
	end
	-- No public request is allowed to carry an event, raw node id, or host item id.
	local choices = {}
	local optionSignature = tern.json.array()
	if target then
		for i, option in ipairs(picker and props(target).items or target.c or {}) do choices[tostring(i)] = option.id end
	end
	for _, option in ipairs(q.options) do
		table.insert(optionSignature, array({ option.id, option.label, option.description or "", option.disabled == true,
			choices[option.id] or "" }))
	end
	-- Fingerprint the complete rendered decision and exact routing data in one
	-- JSON call. Decorative HUD clocks/focus do not alter a decision; repeated
	-- native JSON calls for every TSP property would spend the window's 50ms budget.
	local fingerprint = tern.json.encode(array({ surface.surface.id, target and target.id or root.id,
		q.kind, q.category, q.title, q.prompt, q.document and q.document.content or "", q.actionable,
		q.notice or "", optionSignature }))
	return { question = q, sf = surface.surface.id, target = target and target.id or root.id,
		items = choices, fingerprint = fingerprint }
end

function Requests.new()
	return setmetatable({ states = {}, serial = 0 }, Requests)
end

function Requests:forget(pane)
	self.states[pane] = nil
end

function Requests:read(cx, pane, generation)
	local regions = {}
	local sf = nil
	local clipped = false
	local modal = false
	-- Read the live interaction regions directly, so a long conversation cannot
	-- consume the node budget before its decision or composer is reached.
	for _, name in ipairs({ "layer", "dock" }) do
		local current = cx.session:surface(pane, { root = name, nodes = 2000, depth = 48, max_chars = 64_000 })
		if type(current) ~= "table" or type(current.surface) ~= "table" or current.surface.role ~= "omp.session" then return nil end
		if sf and current.surface.id ~= sf.id then return nil end
		sf = current.surface
		if not complete(current, MAX_TEXT) then clipped = true end
		for _, key in ipairs({ "main", "dock", "layer" }) do
			if type(current[key]) == "table" then
				table.insert(regions, current[key])
				walk(current[key], function(node)
					if node.k == "picker" or (node.k == "overlay" and props(node).modal == true) then modal = true end
				end)
			end
		end
	end
	local merged = { surface = sf, layer = { id = "perch-regions", k = "col", c = regions }, more = clipped and 1 or nil }
	local decision = extract(merged)
	if decision == nil then self.states[pane] = nil; return nil, modal end
	local state = self.states[pane]
	if state == nil or state.generation ~= generation or state.decision.sf ~= decision.sf or state.decision.target ~= decision.target then
		self.serial += 1
		state = { generation = generation, id = "request-" .. tostring(self.serial), revision = 0, decision = decision }
		self.states[pane] = state
	end
	if state.revision == 0 or state.decision.fingerprint ~= decision.fingerprint then
		state.revision += 1
	end
	state.decision = decision
	decision.question.id = state.id
	decision.question.revision = tostring(state.revision)
	if state.consumed then blocked(decision.question, "A response was already submitted. Check the host while this request remains open.") end
	return decision.question, modal
end

function Requests:prepare(cx, pane, generation, command)
	local q = self:read(cx, pane, generation)
	if q == nil or q.id ~= command.requestId or q.revision ~= command.requestRevision then
		error("This host request changed or was already dismissed. Refresh before answering.")
	end
	if q.actionable ~= true then error(q.notice or "This request must be answered in Tern.") end
	local selected = nil
	for _, option in ipairs(q.options) do if option.id == command.answer then selected = option; break end end
	if selected == nil or selected.disabled == true then error("That choice is not available for the current host request.") end
	local state = self.states[pane]
	local decision = state.decision
	-- Reserve before entering an effectful API. A failed invocation has unknown
	-- outcome and may not be turned into an automatic or fresh-id replay.
	state.consumed = true
	return { ev = "activate", sf = decision.sf, id = decision.target, item = decision.items[command.answer] }
end

return Requests
