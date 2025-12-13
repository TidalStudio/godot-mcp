@tool
extends EditorPlugin
## MCP Bridge EditorPlugin
##
## This plugin runs inside the Godot editor and provides a TCP server
## for the MCP server to communicate with. It allows MCP to:
## - Start/stop project playback via EditorInterface
## - Query playing status
##
## The plugin listens on port 6008 (configurable) for simple text commands.

const DEFAULT_PORT: int = 6008

var tcp_server: TCPServer
var port: int = DEFAULT_PORT
var active_connections: Array[StreamPeerTCP] = []


func _enter_tree() -> void:
	# Auto-configure debug settings when plugin is enabled
	_configure_debug_settings()

	# Start TCP server for MCP communication
	tcp_server = TCPServer.new()
	var err := tcp_server.listen(port)
	if err == OK:
		print("[MCP Bridge] Listening on port ", port)
	else:
		push_error("[MCP Bridge] Failed to listen on port %d: %s" % [port, error_string(err)])


func _exit_tree() -> void:
	# Clean up connections
	for connection in active_connections:
		connection.disconnect_from_host()
	active_connections.clear()

	# Stop server
	if tcp_server:
		tcp_server.stop()
		tcp_server = null
	print("[MCP Bridge] Server stopped")


func _configure_debug_settings() -> void:
	# Configure editor debug settings for MCP compatibility
	var settings := EditorInterface.get_editor_settings()

	# Check remote debug port setting
	if settings.has_setting("network/debug/remote_port"):
		var current_port: int = settings.get_setting("network/debug/remote_port")
		print("[MCP Bridge] Remote debug port: ", current_port)

	# Check DAP port setting
	if settings.has_setting("network/debug_adapter/port"):
		var dap_port: int = settings.get_setting("network/debug_adapter/port")
		print("[MCP Bridge] DAP port: ", dap_port)

	# Display reminder for manual step if needed
	print("[MCP Bridge] NOTE: Ensure 'Debug > Keep Debug Server Open' is enabled for DAP access")


func _process(_delta: float) -> void:
	if not tcp_server:
		return

	# Accept new connections
	if tcp_server.is_connection_available():
		var connection := tcp_server.take_connection()
		if connection:
			active_connections.append(connection)
			print("[MCP Bridge] New connection from client")

	# Process existing connections
	var to_remove: Array[int] = []
	for i in range(active_connections.size()):
		var connection := active_connections[i]

		# Check connection status
		connection.poll()
		var status := connection.get_status()

		if status == StreamPeerTCP.STATUS_CONNECTED:
			# Check for incoming data
			var available := connection.get_available_bytes()
			if available > 0:
				var data := connection.get_data(available)
				if data[0] == OK:
					var request := (data[1] as PackedByteArray).get_string_from_utf8()
					_handle_request(connection, request.strip_edges())
		elif status == StreamPeerTCP.STATUS_NONE or status == StreamPeerTCP.STATUS_ERROR:
			# Connection closed or errored
			to_remove.append(i)

	# Remove closed connections (in reverse order to maintain indices)
	for i in range(to_remove.size() - 1, -1, -1):
		active_connections.remove_at(to_remove[i])


func _handle_request(connection: StreamPeerTCP, request: String) -> void:
	print("[MCP Bridge] Received request: ", request)
	var response: String

	if request == "play_main":
		EditorInterface.play_main_scene()
		response = "OK:PLAYING_MAIN"

	elif request.begins_with("play_scene:"):
		var scene_path := request.substr(11).strip_edges()
		EditorInterface.play_custom_scene(scene_path)
		response = "OK:PLAYING:" + scene_path

	elif request == "stop":
		EditorInterface.stop_playing_scene()
		response = "OK:STOPPED"

	elif request == "status":
		if EditorInterface.is_playing_scene():
			var playing_scene := EditorInterface.get_playing_scene()
			response = "STATUS:PLAYING:" + playing_scene
		else:
			response = "STATUS:STOPPED"

	elif request == "ping":
		response = "PONG"

	elif request.begins_with("get_signals:"):
		var node_path := request.substr(12).strip_edges()
		response = _get_node_signals(node_path)

	else:
		response = "ERROR:UNKNOWN_COMMAND:" + request

	print("[MCP Bridge] Sending response: ", response)
	var err := connection.put_data(response.to_utf8_buffer())
	if err != OK:
		push_error("[MCP Bridge] Failed to send response: ", error_string(err))


func _get_node_signals(node_path: String) -> String:
	var scene_root := EditorInterface.get_edited_scene_root()
	if not scene_root:
		return "ERROR:NO_SCENE_OPEN"

	var target_node: Node
	if node_path.is_empty() or node_path == ".":
		target_node = scene_root
	else:
		# Handle paths like "Player" or "Player/Sprite2D"
		target_node = scene_root.get_node_or_null(node_path)

	if not target_node:
		return "ERROR:NODE_NOT_FOUND:" + node_path

	var signals_data := {"signals": [], "node_class": target_node.get_class()}
	var signal_list := target_node.get_signal_list()

	for sig in signal_list:
		var signal_info := {
			"name": sig.name,
			"parameters": [],
			"source": _get_signal_source(target_node, sig.name)
		}

		for arg in sig.args:
			signal_info.parameters.append({
				"name": arg.name,
				"type": _type_to_string(arg.type)
			})

		signals_data.signals.append(signal_info)

	return "SIGNALS:" + JSON.stringify(signals_data)


func _get_signal_source(node: Node, signal_name: String) -> String:
	# Check if signal is defined in the node's script (custom) or inherited (builtin)
	var script := node.get_script() as Script
	if script:
		# Check if the script defines this signal
		for sig in script.get_script_signal_list():
			if sig.name == signal_name:
				return "custom"
	return "builtin"


func _type_to_string(type_id: int) -> String:
	match type_id:
		TYPE_NIL: return "null"
		TYPE_BOOL: return "bool"
		TYPE_INT: return "int"
		TYPE_FLOAT: return "float"
		TYPE_STRING: return "String"
		TYPE_VECTOR2: return "Vector2"
		TYPE_VECTOR2I: return "Vector2i"
		TYPE_VECTOR3: return "Vector3"
		TYPE_VECTOR3I: return "Vector3i"
		TYPE_VECTOR4: return "Vector4"
		TYPE_VECTOR4I: return "Vector4i"
		TYPE_RECT2: return "Rect2"
		TYPE_TRANSFORM2D: return "Transform2D"
		TYPE_TRANSFORM3D: return "Transform3D"
		TYPE_PLANE: return "Plane"
		TYPE_QUATERNION: return "Quaternion"
		TYPE_AABB: return "AABB"
		TYPE_BASIS: return "Basis"
		TYPE_COLOR: return "Color"
		TYPE_NODE_PATH: return "NodePath"
		TYPE_RID: return "RID"
		TYPE_OBJECT: return "Object"
		TYPE_CALLABLE: return "Callable"
		TYPE_SIGNAL: return "Signal"
		TYPE_DICTIONARY: return "Dictionary"
		TYPE_ARRAY: return "Array"
		TYPE_PACKED_BYTE_ARRAY: return "PackedByteArray"
		TYPE_PACKED_INT32_ARRAY: return "PackedInt32Array"
		TYPE_PACKED_INT64_ARRAY: return "PackedInt64Array"
		TYPE_PACKED_FLOAT32_ARRAY: return "PackedFloat32Array"
		TYPE_PACKED_FLOAT64_ARRAY: return "PackedFloat64Array"
		TYPE_PACKED_STRING_ARRAY: return "PackedStringArray"
		TYPE_PACKED_VECTOR2_ARRAY: return "PackedVector2Array"
		TYPE_PACKED_VECTOR3_ARRAY: return "PackedVector3Array"
		TYPE_PACKED_COLOR_ARRAY: return "PackedColorArray"
		_: return "Variant"
