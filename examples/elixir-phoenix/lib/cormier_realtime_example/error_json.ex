defmodule CormierRealtimeExample.ErrorJSON do
  def render(_template, _assigns),
    do: %{code: "internal_error", message: "The request could not be completed."}
end
