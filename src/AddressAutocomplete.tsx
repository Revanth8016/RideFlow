import { useEffect, useRef, useState } from "react";

type AddressAutocompleteProps = {
label: string;
value: string;
onChange: (value: string) => void;
placeholder?: string;
required?: boolean;
};

type AddressSuggestion = {
id: string;
label: string;
};

export default function AddressAutocomplete({
label,
value,
onChange,
placeholder = "Enter postcode or address",
required = false,
}: AddressAutocompleteProps) {
const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
const [loading, setLoading] = useState(false);
const [error, setError] = useState("");
const [open, setOpen] = useState(false);
const [resolving, setResolving] = useState(false);
const [searchEnabled, setSearchEnabled] = useState(false);
const [searchQuery, setSearchQuery] = useState("");

const wrapperRef = useRef<HTMLDivElement>(null);
const requestNumberRef = useRef(0);

// Only search after the user types into this address field.
// Existing addresses loaded while editing will not trigger a search.
useEffect(() => {
if (!searchEnabled) {
setLoading(false);
return;
}

const query = searchQuery.trim();
const requestNumber = ++requestNumberRef.current;
let cancelled = false;

if (query.length < 3) {
  setSuggestions([]);
  setError("");
  setLoading(false);
  setOpen(false);
  return;
}

const timer = window.setTimeout(async () => {
  setLoading(true);
  setError("");

  try {
    const response = await fetch(
      `/api/address-search?q=${encodeURIComponent(query)}`
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Address search failed.");
    }

    const results: AddressSuggestion[] = Array.isArray(data.suggestions)
      ? data.suggestions
      : [];

    if (
      !cancelled &&
      requestNumber === requestNumberRef.current
    ) {
      setSuggestions(results);
      setOpen(results.length > 0);

      if (results.length === 0) {
        setError("No addresses found. Try another postcode.");
      }
    }
  } catch (err) {
    if (
      !cancelled &&
      requestNumber === requestNumberRef.current
    ) {
      setSuggestions([]);
      setOpen(false);
      setError(
        err instanceof Error
          ? err.message
          : "Unable to find addresses. Please try again."
      );
    }
  } finally {
    if (
      !cancelled &&
      requestNumber === requestNumberRef.current
    ) {
      setLoading(false);
    }
  }
}, 300);

return () => {
  cancelled = true;
  window.clearTimeout(timer);
};

}, [searchEnabled, searchQuery]);

// Close the suggestions when the user clicks outside this field.
useEffect(() => {
function handleClickOutside(event: MouseEvent) {
if (
wrapperRef.current &&
!wrapperRef.current.contains(event.target as Node)
) {
setOpen(false);
setSearchEnabled(false);
setError("");
}
}

document.addEventListener("mousedown", handleClickOutside);

return () => {
  document.removeEventListener("mousedown", handleClickOutside);
};

}, []);

function handleInputChange(nextValue: string) {
onChange(nextValue);
setSearchQuery(nextValue);
setSearchEnabled(true);
setOpen(false);
setError("");
}

async function selectAddress(suggestion: AddressSuggestion) {
setResolving(true);
setError("");
setOpen(false);
setSearchEnabled(false);
setSuggestions([]);

try {
  const response = await fetch(
    `/api/address-resolve/${encodeURIComponent(suggestion.id)}`
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || "Could not retrieve the full address."
    );
  }

  if (!data.address) {
    throw new Error("The full address was not returned.");
  }

  setSearchQuery("");
  onChange(data.address);
  setSuggestions([]);
  setOpen(false);
} catch (err) {
  setError(
    err instanceof Error
      ? err.message
      : "Could not select this address. Please try again."
  );
} finally {
  setResolving(false);
}

}

return (
<div className="address-autocomplete" ref={wrapperRef}>
<label className="address-label">
{label}

    <input
      type="text"
      value={value}
      placeholder={placeholder}
      required={required}
      autoComplete="off"
      aria-label={label}
      aria-expanded={open}
      aria-autocomplete="list"
      onChange={(event) => handleInputChange(event.target.value)}
      onFocus={() => {
        // Do not reopen suggestions merely because an existing
        // address field receives focus while editing a booking.
        if (searchEnabled && suggestions.length > 0) {
          setOpen(true);
        }
      }}
    />
  </label>

  {(loading || resolving) && (
    <div className="address-message">
      {resolving
        ? "Loading full address..."
        : "Searching addresses..."}
    </div>
  )}

  {error && !loading && (
    <div className="address-error" role="status">
      {error}
    </div>
  )}

  {open && suggestions.length > 0 && (
    <div className="address-suggestions" role="listbox">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.id}
          type="button"
          role="option"
          aria-selected={false}
          disabled={resolving}
          className="address-suggestion"
          onClick={() => void selectAddress(suggestion)}
        >
          {suggestion.label}
        </button>
      ))}
    </div>
  )}
</div>

);
}