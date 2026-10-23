
import { useCallback, useEffect, useMemo, useState } from "react";

type Booking = {
  id: string;
  passenger: string;
  phone: string;
  pickup: string;
  destination: string;
  time: string;
  driver: string;
  status: string;
};

type Driver = {
  id: string;
  name: string;
  phone: string;
  vehicle_model: string;
  vehicle_registration: string;
  availability: string;
};

type RecoveryIssue = {
  booking: Booking;
  level: "Urgent" | "Warning";
  title: string;
  reason: string;
  recommendation: string;
};

function isUnassigned(value: string): boolean {
  return !value.trim() || value.trim().toLowerCase() === "unassigned";
}

function parsePickupTime(value: string): number | null {
  if (!value.trim()) return null;

  const normalized = value.trim().replace(" ", "T");
  const timestamp = new Date(normalized).getTime();

  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatPickupTime(value: string): string {
  const timestamp = parsePickupTime(value);

  if (timestamp === null) return value || "Time not set";

  return new Date(timestamp).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getApiError(
  result: unknown,
  fallback: string
): string {
  if (
    result &&
    typeof result === "object" &&
    "error" in result &&
    typeof result.error === "string"
  ) {
    return result.error;
  }

  return fallback;
}

function getRecoveryIssues(
  bookings: Booking[],
  drivers: Driver[],
  now: number
): RecoveryIssue[] {
  const driverByName = new Map(
    drivers.map((driver) => [
      driver.name.trim().toLowerCase(),
      driver,
    ])
  );

  const issues: RecoveryIssue[] = [];

  for (const booking of bookings) {
    const status = booking.status.trim().toLowerCase();
    const unassigned = isUnassigned(booking.driver);
    const pickupTime = parsePickupTime(booking.time);
    const minutesUntilPickup =
      pickupTime === null
        ? null
        : (pickupTime - now) / 60000;

    // Cancelled or otherwise completed bookings should not be
    // introduced here as recovery candidates.
    if (status === "cancelled") continue;

    if (status === "at risk") {
      issues.push({
        booking,
        level: "Urgent",
        title: "Booking marked at risk",
        reason: "This booking needs an operational review.",
        recommendation: unassigned
          ? "Choose an available driver and review the pickup details."
          : "Review the driver and journey, then confirm the booking when resolved.",
      });

      continue;
    }

    if (unassigned) {
      const isImminent =
        minutesUntilPickup !== null &&
        minutesUntilPickup >= 0 &&
        minutesUntilPickup <= 90;

      issues.push({
        booking,
        level: isImminent ? "Urgent" : "Warning",
        title: isImminent
          ? "Pickup approaching without a driver"
          : "Driver assignment needed",
        reason:
          minutesUntilPickup !== null && minutesUntilPickup < 0
            ? "The pickup time has passed and no driver is assigned."
            : minutesUntilPickup !== null
              ? `No driver is assigned. Pickup is ${
                  Math.round(minutesUntilPickup)
                } minutes away.`
              : "No driver is assigned and the pickup time could not be read.",
        recommendation:
          "Assign an available driver or review the booking details.",
      });

      continue;
    }

    const assignedDriver = driverByName.get(
      booking.driver.trim().toLowerCase()
    );

    if (!assignedDriver) {
      issues.push({
        booking,
        level: "Urgent",
        title: "Assigned driver not found",
        reason: `The booking refers to "${booking.driver}", which is not in the current driver list.`,
        recommendation:
          "Choose a currently available driver to restore the assignment.",
      });

      continue;
    }

    if (
      assignedDriver.availability.trim().toLowerCase() ===
      "unavailable"
    ) {
      issues.push({
        booking,
        level: "Urgent",
        title: "Assigned driver unavailable",
        reason: `${assignedDriver.name} is currently marked unavailable.`,
        recommendation:
          "Reassign this booking to an available driver.",
      });

      continue;
    }

    if (
      pickupTime !== null &&
      minutesUntilPickup !== null &&
      minutesUntilPickup < 0 &&
      minutesUntilPickup >= -120 &&
      status !== "unassigned"
    ) {
      issues.push({
        booking,
        level: "Warning",
        title: "Pickup time has passed",
        reason:
          "The booking still has an active status, but its pickup time was within the last two hours.",
        recommendation:
          "Check the booking's real-world status before updating it.",
      });
    }
  }

  return issues.sort((a, b) => {
    if (a.level !== b.level) {
      return a.level === "Urgent" ? -1 : 1;
    }

    const aTime = parsePickupTime(a.booking.time) ?? Infinity;
    const bTime = parsePickupTime(b.booking.time) ?? Infinity;

    return aTime - bTime;
  });
}

export default function SmartRecovery() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [selectedDrivers, setSelectedDrivers] = useState<
    Record<string, string>
  >({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const loadData = useCallback(async (quiet = false) => {
    if (quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    setError("");

    try {
      const [bookingResponse, driverResponse] = await Promise.all([
        fetch("/api/bookings", { cache: "no-store" }),
        fetch("/api/drivers", { cache: "no-store" }),
      ]);

      const bookingData: unknown = await bookingResponse
        .json()
        .catch(() => ({}));

      const driverData: unknown = await driverResponse
        .json()
        .catch(() => ({}));

      if (!bookingResponse.ok) {
        throw new Error(
          getApiError(bookingData, "Could not load bookings.")
        );
      }

      if (!driverResponse.ok) {
        throw new Error(
          getApiError(driverData, "Could not load drivers.")
        );
      }

      const bookingRows: unknown[] = Array.isArray(bookingData)
        ? bookingData
        : bookingData &&
            typeof bookingData === "object" &&
            "bookings" in bookingData &&
            Array.isArray(bookingData.bookings)
          ? bookingData.bookings
          : [];

      const driverRows: unknown[] = Array.isArray(driverData)
        ? driverData
        : driverData &&
            typeof driverData === "object" &&
            "drivers" in driverData &&
            Array.isArray(driverData.drivers)
          ? driverData.drivers
          : [];

      const normalizedBookings = bookingRows
        .filter(
          (row): row is Record<string, unknown> =>
            !!row && typeof row === "object"
        )
        .map((row): Booking => ({
          id: String(row.id ?? ""),
          passenger: String(row.passenger ?? ""),
          phone: String(row.phone ?? ""),
          pickup: String(row.pickup ?? ""),
          destination: String(row.destination ?? ""),
          time: String(row.time ?? ""),
          driver: String(row.driver ?? "Unassigned"),
          status: String(row.status ?? "Unassigned"),
        }))
        .filter((booking) => booking.id);

      const normalizedDrivers = driverRows
        .filter(
          (row): row is Record<string, unknown> =>
            !!row && typeof row === "object"
        )
        .map((row): Driver => ({
          id: String(row.id ?? ""),
          name: String(row.name ?? ""),
          phone: String(row.phone ?? ""),
          vehicle_model: String(row.vehicle_model ?? ""),
          vehicle_registration: String(
            row.vehicle_registration ?? ""
          ),
          availability: String(row.availability ?? "Available"),
        }))
        .filter((driver) => driver.id && driver.name);

      setBookings(normalizedBookings);
      setDrivers(normalizedDrivers);
      setNow(Date.now());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load Smart Recovery data."
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const issues = useMemo(
    () => getRecoveryIssues(bookings, drivers, now),
    [bookings, drivers, now]
  );

  const urgentCount = issues.filter(
    (issue) => issue.level === "Urgent"
  ).length;

  const warningCount = issues.filter(
    (issue) => issue.level === "Warning"
  ).length;

  const availableDrivers = drivers.filter(
    (driver) =>
      driver.availability.trim().toLowerCase() === "available"
  );

  async function updateBooking(
    booking: Booking,
    updates: {
      status?: string;
      assignDriverId?: string;
    }
  ) {
    if (savingId) return;

    setSavingId(booking.id);
    setError("");
    setNotice("");

    try {
      const response = await fetch(
        `/api/bookings/${encodeURIComponent(booking.id)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            passenger: booking.passenger,
            phone: booking.phone,
            pickup: booking.pickup,
            destination: booking.destination,
            time: booking.time,
            driver: booking.driver,
            status: booking.status,
            ...updates,
          }),
        }
      );

      const result: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          getApiError(result, "Could not update this booking.")
        );
      }

      setNotice(
        updates.assignDriverId
          ? "Driver assigned successfully. The booking has been confirmed."
          : updates.status === "At risk"
            ? "Booking marked as at risk."
            : "Booking status updated."
      );

      await loadData(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not complete the recovery action."
      );
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <section className="bookings-panel">
        <div className="table-message">
          Loading Smart Recovery…
        </div>
      </section>
    );
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section className="stats-grid">
        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Needs attention</span>
            <span className="stat-icon icon-purple">✧</span>
          </div>
          <div className="stat-number">{issues.length}</div>
          <div className="stat-foot">Recovery recommendations</div>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Urgent</span>
            <span className="stat-icon icon-orange">!</span>
          </div>
          <div className="stat-number">{urgentCount}</div>
          <div className="stat-foot">Prioritise these bookings</div>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Warnings</span>
            <span className="stat-icon icon-blue">◷</span>
          </div>
          <div className="stat-number">{warningCount}</div>
          <div className="stat-foot">Review recommended</div>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Available drivers</span>
            <span className="stat-icon icon-green">✓</span>
          </div>
          <div className="stat-number">{availableDrivers.length}</div>
          <div className="stat-foot">Potential assignment options</div>
        </article>
      </section>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>!</span>
          {error}
          <button type="button" onClick={() => void loadData(true)}>
            Retry
          </button>
        </div>
      )}

      {notice && (
        <div className="alert alert-success" role="status">
          <span>✓</span>
          {notice}
          <button type="button" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </div>
      )}

      <section className="bookings-panel">
        <div className="section-heading">
          <div>
            <h2>Recovery queue</h2>
            <p>
              Review each recommendation before changing a booking.
            </p>
          </div>

          <button
            className="secondary-button"
            type="button"
            disabled={refreshing}
            onClick={() => void loadData(true)}
          >
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>

        {issues.length === 0 ? (
          <div className="table-message">
            No recovery issues were detected from the current booking
            and driver data.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 14, paddingTop: 8 }}>
            {issues.map((issue) => {
              const booking = issue.booking;
              const selectedDriverId =
                selectedDrivers[booking.id] ?? "";

              const isSaving = savingId === booking.id;

              return (
                <article
                  key={booking.id}
                  style={{
                    border: "1px solid var(--border-color, #e5e7eb)",
                    borderRadius: 12,
                    padding: 18,
                    display: "grid",
                    gap: 14,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                          marginBottom: 8,
                        }}
                      >
                        <span className="reference">{booking.id}</span>

                        <span
                          className={`status-pill ${
                            issue.level === "Urgent"
                              ? "status-at-risk"
                              : "status-pending"
                          }`}
                        >
                          <span className="status-dot" />
                          {issue.level}
                        </span>
                      </div>

                      <h3 style={{ margin: "0 0 6px" }}>
                        {issue.title}
                      </h3>

                      <p style={{ margin: 0, color: "var(--muted, #64748b)" }}>
                        {issue.reason}
                      </p>
                    </div>

                    <span
                      className={`status-pill ${
                        booking.status.toLowerCase() === "confirmed"
                          ? "status-confirmed"
                          : booking.status.toLowerCase() === "at risk"
                            ? "status-at-risk"
                            : "status-unassigned"
                      }`}
                    >
                      <span className="status-dot" />
                      {booking.status}
                    </span>
                  </div>

                  <div className="form-grid">
                    <div className="field">
                      <span>Passenger</span>
                      <strong>{booking.passenger || "Not provided"}</strong>
                      <small>{booking.phone || "No phone number"}</small>
                    </div>

                    <div className="field">
                      <span>Pickup time</span>
                      <strong>{formatPickupTime(booking.time)}</strong>
                    </div>

                    <div className="field">
                      <span>Pickup</span>
                      <strong>{booking.pickup || "Not provided"}</strong>
                    </div>

                    <div className="field">
                      <span>Destination</span>
                      <strong>
                        {booking.destination || "Not provided"}
                      </strong>
                    </div>

                    <div className="field">
                      <span>Assigned driver</span>
                      <strong>
                        {isUnassigned(booking.driver)
                          ? "Unassigned"
                          : booking.driver}
                      </strong>
                    </div>
                  </div>

                  <div
                    style={{
                      background: "var(--surface-subtle, #f8fafc)",
                      padding: 12,
                      borderRadius: 8,
                    }}
                  >
                    <strong>Suggested recovery</strong>
                    <p style={{ margin: "5px 0 0" }}>
                      {issue.recommendation}
                    </p>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <select
                      aria-label={`Available driver for ${booking.id}`}
                      value={selectedDriverId}
                      disabled={isSaving || savingId !== null}
                      onChange={(event) =>
                        setSelectedDrivers((current) => ({
                          ...current,
                          [booking.id]: event.target.value,
                        }))
                      }
                      style={{
                        minWidth: 220,
                        maxWidth: "100%",
                        padding: "10px 12px",
                        border: "1px solid var(--border-color, #d1d5db)",
                        borderRadius: 8,
                      }}
                    >
                      <option value="">Choose available driver…</option>
                      {availableDrivers.map((driver) => (
                        <option key={driver.id} value={driver.id}>
                          {driver.name}
                          {driver.vehicle_model
                            ? ` — ${driver.vehicle_model}`
                            : ""}
                          {driver.vehicle_registration
                            ? ` (${driver.vehicle_registration})`
                            : ""}
                        </option>
                      ))}
                    </select>

                    <button
                      className="primary-button"
                      type="button"
                      disabled={
                        !selectedDriverId ||
                        isSaving ||
                        savingId !== null
                      }
                      onClick={() => {
                        void updateBooking(booking, {
                          assignDriverId: selectedDriverId,
                        });
                      }}
                    >
                      {isSaving ? "Saving…" : "Assign driver"}
                    </button>

                    {booking.status.trim().toLowerCase() !== "at risk" && (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={savingId !== null}
                        onClick={() => {
                          void updateBooking(booking, {
                            status: "At risk",
                          });
                        }}
                      >
                        Mark at risk
                      </button>
                    )}

                    {booking.status.trim().toLowerCase() !== "confirmed" &&
                      !isUnassigned(booking.driver) &&
                      drivers.some(
                        (driver) =>
                          driver.name.trim().toLowerCase() ===
                            booking.driver.trim().toLowerCase() &&
                          driver.availability.trim().toLowerCase() !==
                            "unavailable"
                      ) && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={savingId !== null}
                          onClick={() => {
                            void updateBooking(booking, {
                              status: "Confirmed",
                            });
                          }}
                        >
                          Confirm booking
                        </button>
                      )}
                  </div>

                  {availableDrivers.length === 0 && (
                    <p style={{ margin: 0, color: "var(--muted, #64748b)" }}>
                      There are no drivers marked Available. Update driver
                      availability before assigning a driver.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <p style={{ fontSize: 12, color: "var(--muted, #64748b)" }}>
        Smart Recovery uses rules based on the current database. It does
        not automatically contact passengers, change bookings without
        your action, or verify whether a journey actually took place.
      </p>
    </div>
  );
}
