class LimitedBodyReader
  class TooLarge < StandardError; end

  CHUNK_BYTES = 16 * 1_024

  def self.read(stream, limit:)
    body = +"".b
    while (chunk = stream.read(CHUNK_BYTES))
      body << chunk
      raise TooLarge if body.bytesize > limit
    end
    body
  end
end
