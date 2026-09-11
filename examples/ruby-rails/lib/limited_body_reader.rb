class LimitedBodyReader
  class TooLarge < StandardError; end
  class ResponseTooLarge < StandardError; end

  CHUNK_BYTES = 16 * 1_024

  def self.read(stream, limit:)
    body = +"".b
    while (chunk = stream.read(CHUNK_BYTES))
      body << chunk
      raise TooLarge if body.bytesize > limit
    end
    body
  end

  def self.collect(limit:)
    body = +"".b
    yield lambda { |chunk|
      raise ResponseTooLarge if body.bytesize + chunk.bytesize > limit

      body << chunk
    }
    body
  end
end
