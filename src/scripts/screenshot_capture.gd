# screenshot_capture.gd
# AutoLoad singleton for MCP screenshot capture
# This script is automatically injected by the MCP server when running projects
extends Node

const CAPTURE_REQUEST_FILE = "user://mcp_capture_request.txt"
const CAPTURE_OUTPUT_BASE = "user://mcp_screenshot"
const CAPTURE_META_FILE = "user://mcp_screenshot_meta.json"

var _capture_pending := false

func _ready() -> void:
	# Ensure we process even when game is paused
	process_mode = Node.PROCESS_MODE_ALWAYS

func _process(_delta: float) -> void:
	if _capture_pending:
		return

	# Poll for capture request
	if FileAccess.file_exists(CAPTURE_REQUEST_FILE):
		_capture_pending = true
		_handle_capture_request()

func _handle_capture_request() -> void:
	# Read request parameters
	var request_content = FileAccess.get_file_as_string(CAPTURE_REQUEST_FILE)
	var params = _parse_request(request_content)

	# Delete request file immediately to prevent re-processing
	DirAccess.remove_absolute(ProjectSettings.globalize_path(CAPTURE_REQUEST_FILE))

	# Wait for frame to finish rendering
	await RenderingServer.frame_post_draw

	# Capture viewport
	var viewport = get_viewport()
	if viewport == null:
		_write_error("No viewport available")
		_capture_pending = false
		return

	var texture = viewport.get_texture()
	if texture == null:
		_write_error("Viewport has no texture")
		_capture_pending = false
		return

	var image = texture.get_image()
	if image == null:
		_write_error("Failed to get image from viewport texture")
		_capture_pending = false
		return

	# Resize if needed
	var max_dim = params.get("max_dimension", 1920)
	var size = image.get_size()
	if size.x > max_dim or size.y > max_dim:
		var scale_factor = float(max_dim) / max(size.x, size.y)
		var new_size = Vector2i(
			int(size.x * scale_factor),
			int(size.y * scale_factor)
		)
		image.resize(new_size.x, new_size.y, Image.INTERPOLATE_LANCZOS)

	# Save image
	var format = params.get("format", "png")
	var output_path = CAPTURE_OUTPUT_BASE + "." + format
	var save_error: int

	if format == "jpg" or format == "jpeg":
		var quality = params.get("quality", 85) / 100.0
		save_error = image.save_jpg(output_path, quality)
	else:
		save_error = image.save_png(output_path)

	if save_error != OK:
		_write_error("Failed to save image: error code " + str(save_error))
		_capture_pending = false
		return

	# Write metadata
	var meta = {
		"success": true,
		"width": image.get_width(),
		"height": image.get_height(),
		"format": format
	}

	var meta_file = FileAccess.open(CAPTURE_META_FILE, FileAccess.WRITE)
	if meta_file:
		meta_file.store_string(JSON.stringify(meta))
		meta_file.close()

	_capture_pending = false

func _parse_request(content: String) -> Dictionary:
	# Request format: JSON with max_dimension, format, quality
	if content.begins_with("{"):
		var json = JSON.new()
		if json.parse(content) == OK:
			return json.data

	# Fallback: just max_dimension as plain int
	if content.strip_edges().is_valid_int():
		return {"max_dimension": int(content.strip_edges())}

	return {}

func _write_error(message: String) -> void:
	var meta = {
		"success": false,
		"error": message
	}
	var meta_file = FileAccess.open(CAPTURE_META_FILE, FileAccess.WRITE)
	if meta_file:
		meta_file.store_string(JSON.stringify(meta))
		meta_file.close()
