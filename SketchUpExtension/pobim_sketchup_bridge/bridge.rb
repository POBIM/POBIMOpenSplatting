# frozen_string_literal: true

require 'json'
require 'fileutils'

require_relative 'file_server'
require_relative 'mesh_exporter'
require_relative 'dialog_controller'

module PobimSketchBridge
  class Controller
    def initialize
      @file_server = FileServer.new
      @mesh_exporter = MeshExporter.new
      @dialog = nil
    end

    def open_dialog
      ensure_dialog
      @dialog&.show
    end

    private

    def ensure_dialog
      return if @dialog&.alive?

      @dialog = DialogController.new(@file_server, @mesh_exporter)
    end
  end

  def self.controller
    @controller ||= Controller.new
  end

  def self.init_ui
    return if defined?(@menu_initialized) && @menu_initialized

    extensions_menu = UI.menu('Extensions')
    extensions_menu.add_item('POBIM Live Splats Bridge') do
      controller.open_dialog
    end
    @menu_initialized = true
  end
end

PobimSketchBridge.init_ui
