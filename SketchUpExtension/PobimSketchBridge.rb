# frozen_string_literal: true

require 'sketchup.rb'
require 'extensions.rb'

module PobimSketchBridge
  EXTENSION_NAME = 'POBIM Live Splats Bridge'
  EXTENSION_VERSION = '0.1.0'
  EXTENSION_ID = 'pobim_sketchup_bridge'

  file = File.join(__dir__, 'pobim_sketchup_bridge', 'bridge.rb')
  extension = SketchupExtension.new(EXTENSION_NAME, file)
  extension.version = EXTENSION_VERSION
  Sketchup.register_extension(extension, true)
end

