# frozen_string_literal: true

require 'securerandom'
require 'thread'
require 'socket'
require 'pathname'
require 'uri'

module PobimSketchBridge
  class FileServer
    DEFAULT_TTL = 900 # seconds

    def initialize
      @mutex = Mutex.new
      @mounts = {}
      @server = TCPServer.new('127.0.0.1', 0)
      @port = @server.addr[1]
      @running = true
      @thread = Thread.new { run_loop }
    end

    def mount_directory(root_path, ttl: DEFAULT_TTL)
      absolute_root = File.expand_path(root_path)
      raise ArgumentError, "Path does not exist: #{root_path}" unless File.exist?(absolute_root)

      token = SecureRandom.hex(8)

      @mutex.synchronize do
        @mounts[token] = {
          root: absolute_root,
          expires_at: Time.now + ttl,
          ttl: ttl
        }
      end

      { token: token, base_url: "#{base_url}/#{token}" }
    end

    def serve_file(file_path, ttl: DEFAULT_TTL)
      absolute_file = File.expand_path(file_path)
      raise ArgumentError, "File does not exist: #{file_path}" unless File.exist?(absolute_file)

      mount = mount_directory(File.dirname(absolute_file), ttl: ttl)
      relative_name = File.basename(absolute_file)
      "#{mount[:base_url]}/#{percent_encode(relative_name)}"
    end

    def base_url
      "http://127.0.0.1:#{@port}"
    end

    def shutdown
      @running = false
      @server&.close
      @thread&.join
    rescue IOError
      nil
    ensure
      @server = nil
    end

    private

    def run_loop
      while @running
        begin
          socket = @server.accept
          Thread.new(socket) { |client| handle_client(client) }
        rescue IOError, Errno::EBADF
          break
        rescue StandardError
          # Ignore accept errors to keep the loop alive
        end
      end
    end

    def handle_client(socket)
      request_line = socket.gets("\r\n")
      return unless request_line

      method, path, _version = request_line.split(' ', 3)
      drain_headers(socket)

      if method == 'GET'
        serve_path(socket, path)
      else
        respond_with(socket, 405, 'Method Not Allowed')
      end
    rescue StandardError
      respond_with(socket, 500, 'Internal Server Error')
    ensure
      socket.close rescue nil
    end

    def serve_path(socket, raw_path)
      cleanup_mounts
      token, relative_path = extract_token_and_path(raw_path)
      entry = mount_for_token(token)

      if entry
        entry[:expires_at] = Time.now + entry[:ttl].to_i
        resolved = resolve_path(entry[:root], relative_path)
        if resolved && File.file?(resolved)
          return stream_file(socket, resolved)
        end
      end

      respond_with(socket, 404, 'Not Found')
    end

    def stream_file(socket, file_path)
      headers = {
        'Content-Type' => mime_type_for(file_path),
        'Access-Control-Allow-Origin' => '*',
        'Cache-Control' => 'no-store',
        'Content-Length' => File.size(file_path).to_s,
        'Connection' => 'close'
      }
      socket.write(format_response_header(200, 'OK', headers))
      File.open(file_path, 'rb') do |file|
        IO.copy_stream(file, socket)
      end
    end

    def respond_with(socket, status, body)
      body_string = body.to_s
      headers = {
        'Content-Type' => 'text/plain; charset=utf-8',
        'Content-Length' => body_string.bytesize.to_s,
        'Access-Control-Allow-Origin' => '*',
        'Connection' => 'close'
      }
      socket.write(format_response_header(status, http_status_text(status), headers))
      socket.write(body_string)
    end

    def format_response_header(status, message, headers)
      header_lines = headers.map { |key, value| "#{key}: #{value}" }.join("\r\n")
      "HTTP/1.1 #{status} #{message}\r\n#{header_lines}\r\n\r\n"
    end

    def drain_headers(socket)
      while (line = socket.gets("\r\n"))
        break if line == "\r\n"
      end
    end

    def cleanup_mounts
      now = Time.now
      @mutex.synchronize do
        @mounts.delete_if do |_token, entry|
          entry[:expires_at] && entry[:expires_at] < now
        end
      end
    end

    def extract_token_and_path(request_path)
      return [nil, ''] unless request_path

      trimmed = request_path.sub(%r{^/}, '')
      parts = trimmed.split('/', 2)
      token = parts[0]
      relative = parts[1] || ''
      [token, percent_decode(relative)]
    end

    def mount_for_token(token)
      return nil if token.nil? || token.empty?

      @mutex.synchronize { @mounts[token] }
    end

    def resolve_path(root, relative_path)
      safe = Pathname.new("/#{relative_path}").cleanpath.to_s.sub(%r{^/}, '')
      full = File.expand_path(safe, root)
      return nil unless full.start_with?(root)

      full
    end

    def percent_encode(component)
      URI.encode_www_form_component(component.to_s)
    end

    def percent_decode(component)
      URI.decode_www_form_component(component.to_s)
    rescue ArgumentError
      component.to_s
    end

    def mime_type_for(path)
      case File.extname(path).downcase
      when '.ply', '.splat'
        'application/octet-stream'
      when '.obj'
        'text/plain'
      when '.mtl'
        'text/plain'
      when '.gltf'
        'model/gltf+json'
      when '.glb'
        'model/gltf-binary'
      when '.png'
        'image/png'
      when '.jpg', '.jpeg'
        'image/jpeg'
      when '.bin'
        'application/octet-stream'
      else
        'application/octet-stream'
      end
    end

    def http_status_text(status)
      {
        200 => 'OK',
        404 => 'Not Found',
        405 => 'Method Not Allowed',
        500 => 'Internal Server Error'
      }[status] || 'OK'
    end
  end
end

