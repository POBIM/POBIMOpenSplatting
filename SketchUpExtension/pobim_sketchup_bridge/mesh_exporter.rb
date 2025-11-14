# frozen_string_literal: true

require 'fileutils'
require 'tmpdir'

module PobimSketchBridge
  class MeshExporter
    EXPORT_BASENAME = 'pobim_sketchup_proxy'
    MAX_CACHE_AGE = 6 * 60 * 60
    SUPPORTED_FORMATS = %i[obj gltf glb dae].freeze

    def initialize(output_root: nil)
      @output_root = output_root || default_output_root
      FileUtils.mkdir_p(@output_root)
      cleanup_old_exports
    end

    def export_selection(format: :obj)
      model = Sketchup.active_model
      raise 'No active SketchUp model found.' unless model

      target_format = normalize_format(format)
      timestamp = Time.now.utc.strftime('%Y%m%d_%H%M%S_%L')
      folder = File.join(@output_root, "#{EXPORT_BASENAME}_#{timestamp}")
      FileUtils.mkdir_p(folder)

      payload =
        case target_format
        when :obj
          export_obj(model, folder)
        when :gltf, :glb
          export_gltf(model, folder, target_format)
        when :dae
          export_dae(model, folder)
        else
          raise ArgumentError, "Unsupported export format: #{format}"
        end
      payload
    rescue StandardError => e
      FileUtils.rm_rf(folder) if folder && Dir.exist?(folder)
      raise e
    end

    private

    def normalize_format(format)
      sym = format.to_s.downcase.to_sym
      return sym if SUPPORTED_FORMATS.include?(sym)

      :obj
    end

    def default_output_root
      File.join(Dir.tmpdir, 'pobim-sketchup-bridge')
    end

    def cleanup_old_exports
      Dir.glob(File.join(@output_root, "#{EXPORT_BASENAME}_*")).each do |folder|
        next unless File.directory?(folder)
        next unless Time.now - File.mtime(folder) > MAX_CACHE_AGE

        FileUtils.rm_rf(folder)
      end
    rescue StandardError
      # Ignore cleanup errors
    end

    def export_obj(model, folder)
      obj_path = File.join(folder, "#{EXPORT_BASENAME}.obj")
      options = obj_export_options(model.selection)
      success = model.export(obj_path, options)
      raise 'SketchUp OBJ export failed.' unless success

      {
        folder: folder,
        format: :obj,
        main_file: obj_path,
        mtl_file: File.exist?(obj_path.sub(/\.obj\z/i, '.mtl')) ? obj_path.sub(/\.obj\z/i, '.mtl') : nil,
        name: File.basename(obj_path)
      }
    end

    def export_gltf(model, folder, format)
      extension = format == :glb ? '.glb' : '.gltf'
      gltf_path = File.join(folder, "#{EXPORT_BASENAME}#{extension}")
      options = gltf_export_options
      success = model.export(gltf_path, options)
      raise 'SketchUp GLTF export failed.' unless success

      {
        folder: folder,
        format: format,
        main_file: gltf_path,
        mtl_file: nil,
        name: File.basename(gltf_path)
      }
    end

    def export_dae(model, folder)
      dae_path = File.join(folder, "#{EXPORT_BASENAME}.dae")
      options = dae_export_options(model.selection)
      success = model.export(dae_path, options)
      raise 'SketchUp DAE export failed.' unless success

      {
        folder: folder,
        format: :dae,
        main_file: dae_path,
        mtl_file: nil,
        name: File.basename(dae_path)
      }
    end

    def obj_export_options(selection)
      selection_only = selection.respond_to?(:empty?) ? !selection.empty? : false
      {
        triangulated_faces: true,
        doublesided_faces: false,
        edges: false,
        texture_maps: true,
        weld_vertices: true,
        units: 'model',
        swap_yz: false,
        selectionset_only: selection_only
      }
    end

    def gltf_export_options
      {
        triangulated_faces: true,
        export_materials: true,
        export_texture_maps: true,
        y_up: true,
        embed_textures: false
      }
    end

    def dae_export_options(selection)
      selection_only = selection.respond_to?(:empty?) ? !selection.empty? : false
      {
        triangulated_faces: true,
        doublesided_faces: false,
        edges: false,
        texture_maps: true,
        selectionset_only: selection_only
      }
    end
  end
end
