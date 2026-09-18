--!nocheck
-- Icon Maker Sync — Roblox Studio plugin
-- Sends the selected Model / Part to the Icon Maker desktop app (http://127.0.0.1:37420).
-- Install: copy this file into %LOCALAPPDATA%\Roblox\Plugins and restart Studio.

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local AssetService = game:GetService("AssetService")
local RunService = game:GetService("RunService")

local PLUGIN_VERSION = 2

local URL = "http://127.0.0.1:37420"

local toolbar = plugin:CreateToolbar("Icon Maker")
local liveButton = toolbar:CreateButton("Live Sync", "Send every selection to the Icon Maker app", "", "Live Sync")
local sendButton = toolbar:CreateButton("Send", "Send the current selection to the Icon Maker app", "", "Send")
liveButton.ClickableWhenViewportHidden = true
sendButton.ClickableWhenViewportHidden = true

local live = plugin:GetSetting("IconMakerLive")
if live == nil then live = true end
liveButton:SetActive(live)

---------------------------------------------------------------------------
-- base64 for buffers
---------------------------------------------------------------------------
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local b64 = {}
for i = 1, 64 do b64[i - 1] = string.byte(B64, i) end
local EQ = string.byte("=")

local function base64(buf)
	local len = buffer.len(buf)
	local out = buffer.create(math.ceil(len / 3) * 4)
	local o = 0
	for i = 0, len - 3, 3 do
		local n = buffer.readu8(buf, i) * 65536 + buffer.readu8(buf, i + 1) * 256 + buffer.readu8(buf, i + 2)
		buffer.writeu8(out, o, b64[bit32.rshift(n, 18)])
		buffer.writeu8(out, o + 1, b64[bit32.band(bit32.rshift(n, 12), 63)])
		buffer.writeu8(out, o + 2, b64[bit32.band(bit32.rshift(n, 6), 63)])
		buffer.writeu8(out, o + 3, b64[bit32.band(n, 63)])
		o += 4
	end
	local rem = len % 3
	if rem > 0 then
		local i = len - rem
		local n = buffer.readu8(buf, i) * 65536 + (rem == 2 and buffer.readu8(buf, i + 1) * 256 or 0)
		buffer.writeu8(out, o, b64[bit32.rshift(n, 18)])
		buffer.writeu8(out, o + 1, b64[bit32.band(bit32.rshift(n, 12), 63)])
		buffer.writeu8(out, o + 2, rem == 2 and b64[bit32.band(bit32.rshift(n, 6), 63)] or EQ)
		buffer.writeu8(out, o + 3, EQ)
	end
	return buffer.tostring(out)
end

---------------------------------------------------------------------------
-- Asset extraction (works for assets you have permission to edit;
-- otherwise the desktop app downloads them itself)
---------------------------------------------------------------------------
local function normalizeRef(ref)
	if typeof(ref) ~= "string" or ref == "" then return nil end
	if ref:match("^rbxasset://") then return ref end
	local id = ref:match("^rbxassetid://(%d+)") or ref:match("[?&][iI][dD]=(%d+)") or ref:match("^(%d+)$")
	if id then return "rbxassetid://" .. id end
	return ref
end

local cache = {} -- ref -> table | false

local function extractMesh(ref)
	local ok, em = pcall(function()
		return AssetService:CreateEditableMeshAsync(Content.fromUri(ref), { FixedSize = true })
	end)
	if not ok or not em then return false end

	local faces = em:GetFaces()
	local n = #faces * 3
	local pos = buffer.create(n * 12)
	local nrm = buffer.create(n * 12)
	local uv = buffer.create(n * 8)
	local hasN, hasUV = true, true
	local k = 0
	for fi, f in faces do
		local vs = em:GetFaceVertices(f)
		local ns = hasN and em:GetFaceNormals(f) or nil
		local us = hasUV and em:GetFaceUVs(f) or nil
		for i = 1, 3 do
			local p = em:GetPosition(vs[i])
			buffer.writef32(pos, k * 12, p.X)
			buffer.writef32(pos, k * 12 + 4, p.Y)
			buffer.writef32(pos, k * 12 + 8, p.Z)
			if hasN then
				local nv = ns and ns[i] and em:GetNormal(ns[i])
				if nv then
					buffer.writef32(nrm, k * 12, nv.X)
					buffer.writef32(nrm, k * 12 + 4, nv.Y)
					buffer.writef32(nrm, k * 12 + 8, nv.Z)
				else
					hasN = false
				end
			end
			if hasUV then
				local t = us and us[i] and em:GetUV(us[i])
				if t then
					buffer.writef32(uv, k * 8, t.X)
					buffer.writef32(uv, k * 8 + 4, t.Y)
				else
					hasUV = false
				end
			end
			k += 1
		end
		if fi % 4000 == 0 then task.wait() end
	end
	em:Destroy()
	return {
		kind = "mesh",
		pos = base64(pos),
		nrm = hasN and base64(nrm) or nil,
		uv = hasUV and base64(uv) or nil,
	}
end

local function extractImage(ref)
	local ok, img = pcall(function()
		return AssetService:CreateEditableImageAsync(Content.fromUri(ref))
	end)
	if not ok or not img then return false end
	local size = img.Size
	local buf = img:ReadPixelsBuffer(Vector2.zero, size)
	img:Destroy()
	return { kind = "image", w = size.X, h = size.Y, data = base64(buf) }
end

local function getAsset(ref, kind, assets)
	ref = normalizeRef(ref)
	if not ref then return nil end
	if assets[ref] == nil then
		if cache[ref] == nil and not ref:match("^rbxasset://") then
			cache[ref] = (kind == "mesh" and extractMesh or extractImage)(ref)
		end
		assets[ref] = cache[ref] or false
	end
	return ref
end

---------------------------------------------------------------------------
-- Serialization
---------------------------------------------------------------------------
local function v3(v) return { v.X, v.Y, v.Z } end
local function c3(c) return { c.R, c.G, c.B } end
local function cf(c) return { c:GetComponents() } end

local function readProp(inst, ...)
	for _, name in { ... } do
		local ok, v = pcall(function() return inst[name] end)
		if ok and v ~= nil then
			if typeof(v) == "Content" then
				v = v.Uri
			end
			if v ~= nil and v ~= "" then return v end
		end
	end
	return nil
end

local function serializePart(part, pivotInv, assets)
	if part.Transparency >= 0.999 then
		-- still export decals? invisible part -> skip entirely
		return nil
	end
	local info = {
		class = part.ClassName,
		name = part.Name,
		size = v3(part.Size),
		cf = cf(pivotInv * part.CFrame),
		color = c3(part.Color),
		transparency = part.Transparency,
		reflectance = part.Reflectance,
		material = part.Material.Name,
	}

	if part:IsA("WedgePart") then
		info.shape = "Wedge"
	elseif part:IsA("CornerWedgePart") then
		info.shape = "CornerWedge"
	elseif part:IsA("Part") then
		info.shape = part.Shape.Name
	elseif part:IsA("MeshPart") then
		info.shape = "Mesh"
		info.meshId = getAsset(readProp(part, "MeshContent", "MeshId"), "mesh", assets)
		info.textureId = getAsset(readProp(part, "TextureContent", "TextureID"), "image", assets)
	elseif part:IsA("PartOperation") then
		info.shape = "Union"
	else
		info.shape = "Block"
	end

	for _, child in part:GetChildren() do
		if child:IsA("SpecialMesh") then
			info.mesh = {
				type = child.MeshType.Name,
				meshId = getAsset(readProp(child, "MeshId"), "mesh", assets),
				textureId = getAsset(readProp(child, "TextureId"), "image", assets),
				scale = v3(child.Scale),
				offset = v3(child.Offset),
				vertexColor = v3(child.VertexColor),
			}
		elseif child:IsA("SurfaceAppearance") then
			local okColor, tint = pcall(function() return child.Color end)
			info.sa = {
				colorMap = getAsset(readProp(child, "ColorMapContent", "ColorMap"), "image", assets),
				normalMap = getAsset(readProp(child, "NormalMapContent", "NormalMap"), "image", assets),
				roughnessMap = getAsset(readProp(child, "RoughnessMapContent", "RoughnessMap"), "image", assets),
				metalnessMap = getAsset(readProp(child, "MetalnessMapContent", "MetalnessMap"), "image", assets),
				alphaMode = child.AlphaMode.Name,
				color = okColor and tint and c3(tint) or { 1, 1, 1 },
			}
		elseif child:IsA("Decal") then -- includes Texture
			local tex = getAsset(readProp(child, "ColorMapContent", "Texture"), "image", assets)
			if tex and child.Transparency < 0.999 then
				info.decals = info.decals or {}
				table.insert(info.decals, {
					face = child.Face.Name,
					texture = tex,
					color = c3(child.Color3),
					transparency = child.Transparency,
				})
			end
		end
	end
	return info
end

---------------------------------------------------------------------------
-- VFX (ParticleEmitter, Beam, lights)
---------------------------------------------------------------------------
local function prop(inst, name, default)
	local ok, v = pcall(function() return inst[name] end)
	if ok and v ~= nil then return v end
	return default
end
local function ename(inst, name)
	local v = prop(inst, name)
	return v and v.Name or nil
end
local function nseq(s)
	local o = {}
	for _, k in s.Keypoints do table.insert(o, { k.Time, k.Value }) end
	return o
end
local function cseq(s)
	local o = {}
	for _, k in s.Keypoints do table.insert(o, { k.Time, k.Value.R, k.Value.G, k.Value.B }) end
	return o
end
local function nrange(r) return { r.Min, r.Max } end

-- CFrame (relative to the pivot) and size of whatever an effect is attached to
local function hostFrame(host, pivotInv)
	if host and host:IsA("Attachment") then
		return cf(pivotInv * host.WorldCFrame), { 0, 0, 0 }
	elseif host and host:IsA("BasePart") then
		return cf(pivotInv * host.CFrame), v3(host.Size)
	end
	return nil
end

local function serializeEmitter(e, pivotInv, assets)
	local frame, size = hostFrame(e.Parent, pivotInv)
	if not frame then return nil end
	local spread = e.SpreadAngle
	return {
		cf = frame,
		size = size,
		enabled = e.Enabled,
		emitCount = e:GetAttribute("EmitCount") or e:GetAttribute("emitCount"),
		rate = e.Rate,
		lifetime = nrange(e.Lifetime),
		speed = nrange(e.Speed),
		spread = { spread.X, spread.Y },
		rotation = nrange(e.Rotation),
		rotSpeed = nrange(e.RotSpeed),
		accel = v3(pivotInv:VectorToWorldSpace(e.Acceleration)),
		drag = e.Drag,
		pSize = nseq(e.Size),
		transparency = nseq(e.Transparency),
		color = cseq(e.Color),
		lightEmission = e.LightEmission,
		brightness = prop(e, "Brightness", 1),
		texture = getAsset(readProp(e, "TextureContent", "Texture"), "image", assets),
		zOffset = e.ZOffset,
		direction = e.EmissionDirection.Name,
		shape = ename(e, "Shape"),
		shapeStyle = ename(e, "ShapeStyle"),
		shapeInOut = ename(e, "ShapeInOut"),
		timeScale = prop(e, "TimeScale", 1),
		flipLayout = ename(e, "FlipbookLayout"),
		flipMode = ename(e, "FlipbookMode"),
		flipFps = prop(e, "FlipbookFramerate") and nrange(e.FlipbookFramerate) or nil,
		flipStartRandom = prop(e, "FlipbookStartRandom", false),
	}
end

local function serializeBeam(b, pivotInv, assets)
	if not b.Enabled or not b.Attachment0 or not b.Attachment1 then return nil end
	return {
		a0 = cf(pivotInv * b.Attachment0.WorldCFrame),
		a1 = cf(pivotInv * b.Attachment1.WorldCFrame),
		curve0 = b.CurveSize0,
		curve1 = b.CurveSize1,
		width0 = b.Width0,
		width1 = b.Width1,
		color = cseq(b.Color),
		transparency = nseq(b.Transparency),
		lightEmission = b.LightEmission,
		brightness = prop(b, "Brightness", 1),
		texture = getAsset(readProp(b, "TextureContent", "Texture"), "image", assets),
		textureLength = b.TextureLength,
		textureMode = b.TextureMode.Name,
		textureSpeed = b.TextureSpeed,
		segments = b.Segments,
		faceCamera = b.FaceCamera,
	}
end

local function serializeLight(l, pivotInv)
	if not l.Enabled then return nil end
	local frame = hostFrame(l.Parent, pivotInv)
	if not frame then return nil end
	return { cf = frame, color = c3(l.Color), brightness = l.Brightness, range = prop(l, "Range", 8) }
end

local function pickTarget()
	for _, inst in Selection:Get() do
		if inst:IsA("BasePart") or inst:IsA("Model") or inst:IsA("Folder") or inst:IsA("Accessory") or inst:IsA("Tool") then
			return inst
		end
		local model = inst:FindFirstAncestorWhichIsA("Model")
		if model and model ~= workspace then return model end
	end
	return nil
end

local function buildPayload(target)
	local pivot
	if target:IsA("PVInstance") then
		pivot = target:GetPivot()
	else
		pivot = CFrame.new()
	end
	local pivotInv = pivot:Inverse()
	local assets = {}
	local parts = {}
	local list = target:GetDescendants()
	if target:IsA("BasePart") then table.insert(list, 1, target) end
	local vfx = { emitters = {}, beams = {}, lights = {} }
	for _, d in list do
		local ok, info, into = pcall(function()
			if d:IsA("BasePart") then
				return serializePart(d, pivotInv, assets), parts
			elseif d:IsA("ParticleEmitter") then
				return serializeEmitter(d, pivotInv, assets), vfx.emitters
			elseif d:IsA("Beam") then
				return serializeBeam(d, pivotInv, assets), vfx.beams
			elseif d:IsA("Light") then
				return serializeLight(d, pivotInv), vfx.lights
			end
			return nil
		end)
		if not ok then
			warn("[Icon Maker] Skipped " .. d:GetFullName() .. ": " .. tostring(info))
		elseif info then
			table.insert(into, info)
		end
	end
	-- JSON can't hold `false` keys nicely for missing assets; send as a list of refs to fetch
	local out, missing = {}, {}
	for ref, data in assets do
		if data then out[ref] = data else table.insert(missing, ref) end
	end
	return { version = PLUGIN_VERSION, name = target.Name, parts = parts, vfx = vfx, assets = out, missing = missing }
end

---------------------------------------------------------------------------
-- Sending
---------------------------------------------------------------------------
local warned = false
local sendToken = 0

local function send()
	-- the play-test client can't make HTTP requests; only sync from edit mode / server
	if RunService:IsRunning() and RunService:IsClient() then return end
	local target = pickTarget()
	if not target then return end
	sendToken += 1
	local token = sendToken
	local payload = buildPayload(target)
	if token ~= sendToken then return end -- a newer selection superseded this one
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = URL .. "/model",
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode(payload),
		})
	end)
	if ok and res.Success then
		warned = false
	elseif not warned then
		warned = true
		warn("[Icon Maker] Could not reach the Icon Maker app at " .. URL .. ". Is it running? (" .. tostring(ok and res.StatusCode or res) .. ")")
	end
end

local pending = false
Selection.SelectionChanged:Connect(function()
	if not live or pending then return end
	pending = true
	task.delay(0.15, function()
		pending = false
		send()
	end)
end)

liveButton.Click:Connect(function()
	live = not live
	liveButton:SetActive(live)
	plugin:SetSetting("IconMakerLive", live)
	if live then task.spawn(send) end
end)

sendButton.Click:Connect(function()
	sendButton:SetActive(false)
	task.spawn(send)
end)
