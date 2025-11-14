# frozen_string_literal: true

require 'json'
require 'time'

module PobimSketchBridge
  class DialogController
    INCH_TO_METER = 0.0254
    CAMERA_PUSH_INTERVAL = 0.08

    def initialize(file_server, mesh_exporter)
      @file_server = file_server
      @mesh_exporter = mesh_exporter
      @dialog = build_dialog
      @camera_observer = nil
      @suppress_camera_push = false
      @camera_push_rearm_timer = nil
      @last_camera_payload_at = nil
      @mesh_payload_cache = {}
      @last_mesh_payload = nil
      @last_gaussian_payload = nil
      bind_callbacks
    end

    def show
      puts '[PobimSketchBridge] Opening dialog...'
      attach_camera_observer
      @dialog.show
      @dialog.bring_to_front
      puts '[PobimSketchBridge] Dialog shown, sending initial state...'
      send_initial_state
      ensure_mesh_ready
      push_camera_from_view(current_view)
      puts '[PobimSketchBridge] Dialog initialization complete'
    end

    def alive?
      @dialog&.visible?
    end

    private

    def build_dialog
      dialog = UI::HtmlDialog.new(
        dialog_title: 'POBIM Live Splats Bridge',
        resizable: true,
        width: 1400,
        height: 900,
        scrollable: false,
        style: UI::HtmlDialog::STYLE_DIALOG
      )
      dialog.set_file(File.join(__dir__, 'ui', 'index.html'))
      dialog.set_on_closed { cleanup }
      dialog
    end

    def bind_callbacks
      @dialog.add_action_callback('bridgeReady') { |_ctx, payload| handle_bridge_ready(payload) }
      @dialog.add_action_callback('requestMeshExport') { handle_mesh_export }
      @dialog.add_action_callback('requestMeshReload') { handle_mesh_reload }
      @dialog.add_action_callback('requestGltfUpdate') { handle_gltf_update }
      @dialog.add_action_callback('requestGaussianFile') { handle_gaussian_pick }
      @dialog.add_action_callback('dialogCameraChanged') { |_ctx, payload| handle_dialog_camera(payload) }
      @dialog.add_action_callback('requestCameraOnce') { push_camera_from_view(current_view) }
    end

    def handle_bridge_ready(payload)
      puts '[PobimSketchBridge] Received bridgeReady from dialog'
      puts "[PobimSketchBridge] Payload: #{payload.inspect}"
      send_initial_state
      ensure_mesh_ready
      push_camera_from_view(current_view)
      puts '[PobimSketchBridge] Initial state sent to dialog'
    end

    def handle_mesh_export
      ensure_mesh_ready(format: :obj, force: true)
    rescue StandardError => e
      UI.messagebox("Mesh export failed:\n#{e.message}")
    end

    def handle_mesh_reload
      ensure_mesh_ready(format: :dae, force: true)
    rescue StandardError => e
      UI.messagebox("Mesh reload failed:\n#{e.message}")
    end

    def handle_gltf_update
      puts '[PobimSketchBridge] Exporting GLTF for shared canvas'
      ensure_mesh_ready(format: :gltf, force: true)
    rescue StandardError => e
      puts "[PobimSketchBridge] GLTF export failed: #{e.message}"
      UI.messagebox("GLTF export failed:\n#{e.message}")
    end

    def handle_gaussian_pick
      puts '[PobimSketchBridge] Opening file picker for Gaussian splats'
      path = UI.openpanel('Select Gaussian Splats (.ply)', '', 'Gaussian Splats (*.ply;*.splat)|*.ply;*.splat||')
      return unless path

      puts "[PobimSketchBridge] User selected file: #{path}"
      url = @file_server.serve_file(path, ttl: 3600)
      puts "[PobimSketchBridge] File served at URL: #{url}"
      payload = {
        name: File.basename(path),
        url: url,
        timestamp: Time.now.utc.iso8601
      }
      @last_gaussian_payload = payload
      puts "[PobimSketchBridge] Broadcasting gaussian-ready: #{payload.inspect}"
      broadcast('gaussian-ready', payload)
    rescue StandardError => e
      puts "[PobimSketchBridge] Error loading Gaussian: #{e.message}"
      puts e.backtrace.join("\n")
      UI.messagebox("Unable to load Gaussian file:\n#{e.message}")
    end

    def handle_dialog_camera(payload)
      data = parse_payload(payload)
      return unless data.is_a?(Hash)
      return unless data['eye'] && data['target']

      @suppress_camera_push = true
      apply_camera_from_dialog(data)
      reset_camera_push_guard
    rescue StandardError => e
      warn("[PobimSketchBridge] Failed to sync camera from dialog: #{e.message}")
    end

    def apply_camera_from_dialog(data)
      view = current_view
      return unless view

      current_camera = view.camera
      eye = hash_to_point(data['eye'])
      target = hash_to_point(data['target'])
      up = hash_to_vector(data['up'])

      current_camera.set(eye, target, up)
      current_camera.fov = data['fov'] if data['fov']
      view.camera = current_camera
    end

    def reset_camera_push_guard
      @camera_push_rearm_timer ||= 0
      UI.start_timer(0.1, false) do
        @suppress_camera_push = false
        @camera_push_rearm_timer = nil
      end
    end

    def ensure_mesh_ready(format: :dae, force: false)
      format = format.to_sym
      @mesh_payload_cache ||= {}
      cached = @mesh_payload_cache[format]
      return if cached && !force

      puts "[PobimSketchBridge] Exporting mesh from SketchUp model (format=#{format})"
      exported = @mesh_exporter.export_selection(format: format)
      puts "[PobimSketchBridge] Mesh exported: #{exported.inspect}"
      mount = @file_server.mount_directory(exported[:folder], ttl: 3600)
      payload = {
        name: exported[:name],
        format: exported[:format],
        url: "#{mount[:base_url]}/#{File.basename(exported[:main_file])}",
        mtl_url: exported[:mtl_file] ? "#{mount[:base_url]}/#{File.basename(exported[:mtl_file])}" : nil,
        base_url: mount[:base_url],
        origin_offset: current_origin_offset,
        timestamp: Time.now.utc.iso8601
      }
      @mesh_payload_cache[format] = payload
      @last_mesh_payload = payload
      puts "[PobimSketchBridge] Broadcasting mesh-ready: #{payload.inspect}"
      broadcast('mesh-ready', payload)
    end

    def send_initial_state
      payload = {
        model_name: current_model&.title || 'Untitled Model',
        origin_offset: current_origin_offset,
        unit_scale: INCH_TO_METER,
        mesh: @last_mesh_payload,
        gaussian: @last_gaussian_payload,
        camera: camera_payload(current_view)
      }
      broadcast('init', payload)
    end

    def broadcast(type, payload = {})
      return unless @dialog

      puts "[PobimSketchBridge] Broadcasting '#{type}' to dialog"
      json = JSON.generate(payload || {})
      puts "[PobimSketchBridge] Payload size: #{json.length} bytes"

      script = <<~JS
        if (window.PobimSketchBridge && typeof window.PobimSketchBridge.fromSketchUp === 'function') {
          window.PobimSketchBridge.fromSketchUp('#{type}', #{json});
        } else {
          console.error('[SketchUp] PobimSketchBridge not ready yet');
        }
      JS
      @dialog.execute_script(script)
      puts "[PobimSketchBridge] Script executed"
    end

    def attach_camera_observer
      return if @camera_observer

      @camera_observer = ViewSyncObserver.new(self)
      current_view&.add_observer(@camera_observer)
    end

    def detach_camera_observer
      return unless @camera_observer

      current_view&.remove_observer(@camera_observer)
      @camera_observer = nil
    end

    def push_camera_from_view(view)
      return unless view && !@suppress_camera_push

      now = Time.now
      if @last_camera_payload_at && (now - @last_camera_payload_at) < CAMERA_PUSH_INTERVAL
        return
      end

      payload = camera_payload(view)
      return unless payload

      # puts "[PobimSketchBridge] Pushing camera to dialog: eye=#{payload[:eye]}, target=#{payload[:target]}"
      broadcast('camera', payload)
      @last_camera_payload_at = now
    end

    def camera_payload(view)
      return nil unless view

      camera = view.camera
      {
        eye: point_to_hash(camera.eye),
        target: point_to_hash(camera.target),
        up: vector_to_hash(camera.up),
        fov: camera.fov,
        aspect: safe_aspect_ratio(view)
      }
    end

    def current_model
      Sketchup.active_model
    end

    def current_view
      current_model&.active_view
    end

    def current_origin_offset
      model = current_model
      return { x: 0.0, y: 0.0, z: 0.0 } unless model

      axes_origin = model.axes&.origin
      return point_to_hash(axes_origin) if axes_origin

      { x: 0.0, y: 0.0, z: 0.0 }
    end

    def parse_payload(payload)
      return payload if payload.is_a?(Hash)
      return {} unless payload.is_a?(String) && !payload.empty?

      JSON.parse(payload)
    rescue JSON::ParserError
      {}
    end

    def point_to_hash(point)
      return { x: 0.0, y: 0.0, z: 0.0 } unless point

      {
        x: point.x.to_f * INCH_TO_METER,
        y: point.y.to_f * INCH_TO_METER,
        z: point.z.to_f * INCH_TO_METER
      }
    end

    def vector_to_hash(vector)
      return { x: 0.0, y: 0.0, z: 1.0 } unless vector

      {
        x: vector.x.to_f,
        y: vector.y.to_f,
        z: vector.z.to_f
      }
    end

    def hash_to_point(data)
      return Geom::Point3d.new unless data.is_a?(Hash)

      Geom::Point3d.new(
        meters_to_inches(data['x']),
        meters_to_inches(data['y']),
        meters_to_inches(data['z'])
      )
    end

    def hash_to_vector(data)
      return Geom::Vector3d.new(0, 0, 1) unless data.is_a?(Hash)

      Geom::Vector3d.new(
        data['x'].to_f,
        data['y'].to_f,
        data['z'].to_f
      )
    end

    def meters_to_inches(value)
      value.to_f / INCH_TO_METER
    end

    def safe_aspect_ratio(view)
      width = view&.vpwidth.to_f
      height = view&.vpheight.to_f
      return 1.0 if width <= 0 || height <= 0

      width / height
    end

    def cleanup
      detach_camera_observer
      @dialog = nil
    end

    class ViewSyncObserver < Sketchup::ViewObserver
      def initialize(controller)
        @controller = controller
      end

      def onViewChanged(view)
        @controller&.send(:push_camera_from_view, view)
      end
    end
  end
end
