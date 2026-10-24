import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import AddressAutocomplete from "./AddressAutocomplete";
import "./App.css";

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

type BookingForm = Omit<Booking, "id">;

type Driver = {
  id: string;
  name: string;
  phone: string;
  vehicle_model: string;
  vehicle_registration: string;
  availability: string;
};

type AssignmentFilter = "All bookings" | "Assigned" | "Unassigned";

type RecoveryIssue = {
  booking: Booking;
  reasons: string[];
  severity: "High" | "Medium";
};

function normalizeAvailability(value: unknown): string {
  const availability = String(value ?? "Available").trim().toLowerCase();

  if (availability === "available") return "Available";
  if (availability === "busy") return "Busy";
  if (availability === "unavailable") return "Unavailable";

  return availability
    ? availability.charAt(0).toUpperCase() + availability.slice(1)
    : "Available";
}

function normalizeDriver(value: unknown, index: number): Driver | null {
  if (!value || typeof value !== "object") return null;

  const item = value as Record<string, unknown>;
  const name = String(item.name ?? item.driver_name ?? "").trim();

  if (!name) return null;

  return {
    id: String(item.id ?? index),
    name,
    phone: String(item.phone ?? ""),
    vehicle_model: String(item.vehicle_model ?? item.vehicleModel ?? ""),
    vehicle_registration: String(
      item.vehicle_registration ?? item.vehicleRegistration ?? ""
    ),
    availability: normalizeAvailability(item.availability),
  };
}

const emptyForm: BookingForm = {
  passenger: "",
  phone: "",
  pickup: "",
  destination: "",
  time: "",
  driver: "",
  status: "Unassigned",
};

const emptyDriverForm = {
  name: "",
  phone: "",
  vehicle_model: "",
  vehicle_registration: "",
  availability: "Available",
};

const navigation = [
  { name: "Dashboard", icon: "▦" },
  { name: "Bookings", icon: "▤" },
  { name: "Drivers", icon: "♙" },
  { name: "Routes", icon: "⌁" },
  { name: "Smart Recovery", icon: "✧" },
];

const bookingStatuses = ["Confirmed", "At risk", "Unassigned"];

function readField(
  item: Record<string, unknown>,
  names: string[],
  fallback = ""
): string {
  for (const name of names) {
    const value = item[name];

    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }

  return fallback;
}

function normalizeBooking(value: unknown, index: number): Booking {
  if (!value || typeof value !== "object") {
    return {
      id: `RF-${index + 1}`,
      passenger: "",
      phone: "",
      pickup: "",
      destination: "",
      time: "",
      driver: "Unassigned",
      status: "Unassigned",
    };
  }

  const item = value as Record<string, unknown>;

  return {
    id: readField(
      item,
      ["reference", "booking_reference", "bookingId", "id"],
      `RF-${index + 1}`
    ),
    passenger: readField(item, ["passenger", "passenger_name", "name"]),
    phone: readField(item, ["phone", "passenger_phone", "telephone"]),
    pickup: readField(item, [
      "pickup",
      "pickup_address",
      "pickup_location",
    ]),
    destination: readField(item, [
      "destination",
      "destination_address",
      "dropoff",
      "dropoff_address",
    ]),
    time: readField(item, [
      "time",
      "booking_time",
      "pickup_time",
      "datetime",
    ]),
    driver: readField(item, ["driver", "driver_name"], "Unassigned"),
    status: readField(item, ["status"], "Unassigned"),
  };
}

function getStatusClass(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "confirmed":
      return "status-confirmed";
    case "at risk":
      return "status-at-risk";
    case "cancelled":
      return "status-cancelled";
    case "pending":
      return "status-pending";
    case "unassigned":
      return "status-unassigned";
    default:
      return "status-unassigned";
  }
}

/**
 * Identifies bookings that may need an operator's attention.
 * This is rules-based review only. It does not automatically
 * reassign drivers or change bookings.
 */
function getRecoveryIssues(
  bookings: Booking[],
  drivers: Driver[]
): RecoveryIssue[] {
  const now = Date.now();

  return bookings
    .map((booking) => {
      const reasons: string[] = [];
      const status = booking.status.trim().toLowerCase();
      const driverName = booking.driver.trim().toLowerCase();
      const assigned = driverName !== "" && driverName !== "unassigned";

      const assignedDriver = assigned
        ? drivers.find(
            (driver) => driver.name.trim().toLowerCase() === driverName
          )
        : undefined;

      if (!assigned) {
        reasons.push("No driver assigned");
      } else if (!assignedDriver) {
        reasons.push("Assigned driver is not in the saved driver list");
      } else if (
        assignedDriver.availability.trim().toLowerCase() === "unavailable"
      ) {
        reasons.push("Assigned driver is marked unavailable");
      }

      if (status === "at risk") {
        reasons.push("Booking is marked at risk");
      }

      const bookingTime = booking.time
        ? new Date(booking.time.replace(" ", "T")).getTime()
        : Number.NaN;

      if (
        Number.isFinite(bookingTime) &&
        bookingTime < now &&
        status !== "cancelled"
      ) {
        reasons.push("Pickup time has passed — check the booking status");
      }

      if (reasons.length === 0) return null;

      const severity: RecoveryIssue["severity"] =
        !assigned ||
        !assignedDriver ||
        assignedDriver?.availability.trim().toLowerCase() === "unavailable" ||
        status === "at risk"
          ? "High"
          : "Medium";

      return { booking, reasons, severity };
    })
    .filter((issue): issue is RecoveryIssue => issue !== null)
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "High" ? -1 : 1;
      return a.booking.time.localeCompare(b.booking.time);
    });
}

function App() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [activePage, setActivePage] = useState("Dashboard");

  const [modalOpen, setModalOpen] = useState(false);
  const [driverModalOpen, setDriverModalOpen] = useState(false);

  const [editingBookingId, setEditingBookingId] = useState<string | null>(
    null
  );

  const [form, setForm] = useState<BookingForm>(emptyForm);
  const [newDriver, setNewDriver] = useState(emptyDriverForm);

  const [loading, setLoading] = useState(true);
  const [driversLoading, setDriversLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingNewDriver, setSavingNewDriver] = useState(false);
  const [savingDriverId, setSavingDriverId] = useState<string | null>(null);

  const [error, setError] = useState("");
  const [driverError, setDriverError] = useState("");
  const [notice, setNotice] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All statuses");
  const [assignmentFilter, setAssignmentFilter] =
    useState<AssignmentFilter>("All bookings");

  async function loadBookings() {
    try {
      const response = await fetch("/api/bookings", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Could not load bookings.");
      }

      const data: unknown = await response.json();

      const rows: unknown[] = Array.isArray(data)
        ? data
        : data &&
            typeof data === "object" &&
            Array.isArray((data as { bookings?: unknown[] }).bookings)
          ? (data as { bookings: unknown[] }).bookings
          : [];

      setBookings(rows.map(normalizeBooking));
      setError("");
    } catch {
      setError(
        "Unable to load bookings. Check that the RideFlow backend is running."
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadDrivers(): Promise<Driver[]> {
    setDriversLoading(true);
    setDriverError("");

    try {
      const response = await fetch("/api/drivers", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Could not load drivers.");
      }

      const data: unknown = await response.json();

      const rows: unknown[] = Array.isArray(data)
        ? data
        : data &&
            typeof data === "object" &&
            Array.isArray((data as { drivers?: unknown[] }).drivers)
          ? (data as { drivers: unknown[] }).drivers
          : [];

      const latestDrivers = rows
        .map((driver, index) => normalizeDriver(driver, index))
        .filter((driver): driver is Driver => driver !== null);

      setDrivers(latestDrivers);

      return latestDrivers;
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not load drivers. Check that the backend is running.";

      setDriverError(message);
      throw err;
    } finally {
      setDriversLoading(false);
    }
  }

  async function saveDriverAvailability(driver: Driver) {
    setSavingDriverId(driver.id);
    setDriverError("");
    setError("");
    setNotice("");

    try {
      const response = await fetch(
        `/api/drivers/${encodeURIComponent(driver.id)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: driver.name,
            phone: driver.phone,
            vehicle_model: driver.vehicle_model,
            vehicle_registration: driver.vehicle_registration,
            availability: normalizeAvailability(driver.availability),
          }),
        }
      );

      const result: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message =
          result &&
          typeof result === "object" &&
          "error" in result &&
          typeof result.error === "string"
            ? result.error
            : "Could not update driver availability.";

        throw new Error(message);
      }

      const latestDrivers = await loadDrivers();
      const savedDriver = latestDrivers.find(
        (item) => item.id === driver.id
      );

      if (
        savedDriver &&
        savedDriver.availability !== normalizeAvailability(driver.availability)
      ) {
        throw new Error(
          `The server still reports ${savedDriver.availability} for ${driver.name}. Check the backend update route.`
        );
      }

      setNotice(`${driver.name}'s availability was updated successfully.`);
    } catch (err) {
      setDriverError(
        err instanceof Error
          ? err.message
          : "Could not update driver availability."
      );
    } finally {
      setSavingDriverId(null);
    }
  }

  async function handleSaveDriver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (savingNewDriver) return;

    const name = newDriver.name.trim();

    if (!name) {
      setDriverError("Please enter the driver's name.");
      return;
    }

    setSavingNewDriver(true);
    setDriverError("");
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/drivers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          phone: newDriver.phone.trim(),
          vehicle_model: newDriver.vehicle_model.trim(),
          vehicle_registration:
            newDriver.vehicle_registration.trim().toUpperCase(),
          availability: normalizeAvailability(newDriver.availability),
        }),
      });

      const result: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message =
          result &&
          typeof result === "object" &&
          "error" in result &&
          typeof result.error === "string"
            ? result.error
            : "Could not save the driver.";

        throw new Error(message);
      }

      await loadDrivers();

      setNewDriver({ ...emptyDriverForm });
      setDriverModalOpen(false);
      setNotice(`${name} was added successfully.`);
    } catch (err) {
      setDriverError(
        err instanceof Error
          ? err.message
          : "Could not save the driver. Please try again."
      );
    } finally {
      setSavingNewDriver(false);
    }
  }

  useEffect(() => {
    void loadBookings();

    void loadDrivers().catch(() => {
      // The driver error is displayed in the Drivers section.
    });
  }, []);

  function openBookingsWithFilters(
    status: string = "All statuses",
    assignment: AssignmentFilter = "All bookings"
  ) {
    setActivePage("Bookings");
    setSearchQuery("");
    setStatusFilter(status);
    setAssignmentFilter(assignment);
    setError("");
    setNotice("");
  }

  function openDriversPage() {
    setActivePage("Drivers");
    setError("");
    setNotice("");
    void loadDrivers().catch(() => {});
  }

  function handleCardKeyDown(
    event: KeyboardEvent<HTMLElement>,
    action: () => void
  ) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  }

  function updateForm(field: keyof BookingForm, value: string) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function openAddDriver() {
    setDriverError("");
    setError("");
    setNotice("");
    setNewDriver({ ...emptyDriverForm });
    setDriverModalOpen(true);
  }

  async function openNewBooking() {
    setError("");
    setNotice("");
    setDriverError("");
    setEditingBookingId(null);
    setForm({ ...emptyForm });

    try {
      await loadDrivers();
      setModalOpen(true);
    } catch {
      setError(
        "Could not refresh driver availability. Please try again before creating a booking."
      );
    }
  }

  async function openEditBooking(booking: Booking) {
    setError("");
    setNotice("");
    setDriverError("");

    try {
      const latestDrivers = await loadDrivers();

      const savedDriver = latestDrivers.find(
        (driver) =>
          driver.name.trim().toLowerCase() ===
          booking.driver.trim().toLowerCase()
      );

      setEditingBookingId(booking.id);

      setForm({
        passenger: booking.passenger,
        phone: booking.phone,
        pickup: booking.pickup,
        destination: booking.destination,
        time: booking.time,
        driver: savedDriver?.name ?? booking.driver,
        status: bookingStatuses.includes(booking.status)
          ? booking.status
          : "Unassigned",
      });

      setModalOpen(true);
    } catch {
      setError(
        "Could not refresh driver availability. Please refresh the Drivers page and try again."
      );
    }
  }

  async function handleSaveBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (saving) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const latestDrivers = await loadDrivers();

      const selectedDriverName = form.driver.trim();

      const selectedDriver = latestDrivers.find(
        (driver) =>
          driver.name.trim().toLowerCase() ===
          selectedDriverName.toLowerCase()
      );

      if (
        selectedDriverName &&
        selectedDriverName.toLowerCase() !== "unassigned"
      ) {
        if (!selectedDriver) {
          throw new Error(
            "This driver could not be found in the latest driver list. Refresh the Drivers page and try again."
          );
        }

        const availability = selectedDriver.availability
          .trim()
          .toLowerCase();

        const existingBookingDriver = bookings.find(
          (booking) => booking.id === editingBookingId
        )?.driver;

        const isAlreadyAssignedToThisBooking =
          editingBookingId !== null &&
          existingBookingDriver?.trim().toLowerCase() ===
            selectedDriver.name.trim().toLowerCase();

        if (
          availability !== "available" &&
          !isAlreadyAssignedToThisBooking
        ) {
          throw new Error(
            `${selectedDriver.name} is currently ${selectedDriver.availability}. Choose an available driver.`
          );
        }
      }

      const wasEditing = editingBookingId !== null;

      const response = await fetch(
        editingBookingId
          ? `/api/bookings/${encodeURIComponent(editingBookingId)}`
          : "/api/bookings",
        {
          method: editingBookingId ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...form,
            passenger: form.passenger.trim(),
            phone: form.phone.trim(),
            pickup: form.pickup.trim(),
            destination: form.destination.trim(),
            time: form.time,
            driver: selectedDriverName || "Unassigned",
            status: bookingStatuses.includes(form.status)
              ? form.status
              : "Unassigned",
          }),
        }
      );

      const result: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message =
          result &&
          typeof result === "object" &&
          "error" in result &&
          typeof result.error === "string"
            ? result.error
            : "Could not save the booking.";

        throw new Error(message);
      }

      await loadBookings();
      await loadDrivers();

      setForm({ ...emptyForm });
      setEditingBookingId(null);
      setModalOpen(false);
      setActivePage("Bookings");
      setSearchQuery("");
      setStatusFilter("All statuses");
      setAssignmentFilter("All bookings");

      setNotice(
        wasEditing
          ? "Booking updated successfully."
          : "Booking saved successfully."
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong."
      );
    } finally {
      setSaving(false);
    }
  }

  const filteredBookings = bookings.filter((booking) => {
    const query = searchQuery.trim().toLowerCase();

    const matchesSearch =
      query === "" ||
      [
        booking.id,
        booking.passenger,
        booking.phone,
        booking.pickup,
        booking.destination,
        booking.driver,
      ].some((value) => value.toLowerCase().includes(query));

    const matchesStatus =
      statusFilter === "All statuses" ||
      booking.status.toLowerCase() === statusFilter.toLowerCase();

    const driverName = booking.driver.trim().toLowerCase();
    const hasAssignedDriver =
      driverName !== "" && driverName !== "unassigned";

    const matchesAssignment =
      assignmentFilter === "All bookings" ||
      (assignmentFilter === "Assigned" && hasAssignedDriver) ||
      (assignmentFilter === "Unassigned" && !hasAssignedDriver);

    return matchesSearch && matchesStatus && matchesAssignment;
  });

  const totalBookings = bookings.length;

  const confirmedBookings = bookings.filter(
    (booking) => booking.status.trim().toLowerCase() === "confirmed"
  ).length;

  const unassignedBookings = bookings.filter(
    (booking) =>
      !booking.driver.trim() ||
      booking.driver.trim().toLowerCase() === "unassigned"
  ).length;

  const assignedDrivers = new Set(
    bookings
      .map((booking) => booking.driver.trim().toLowerCase())
      .filter((driver) => driver !== "" && driver !== "unassigned")
  ).size;

  const availableDrivers = drivers.filter(
    (driver) => driver.availability.trim().toLowerCase() === "available"
  ).length;

  const busyDrivers = drivers.filter(
    (driver) => driver.availability.trim().toLowerCase() === "busy"
  ).length;

  const unavailableDrivers = drivers.filter(
    (driver) => driver.availability.trim().toLowerCase() === "unavailable"
  ).length;

  const recoveryIssues = getRecoveryIssues(bookings, drivers);

  const highPriorityRecoveries = recoveryIssues.filter(
    (issue) => issue.severity === "High"
  ).length;

  const mediumPriorityRecoveries = recoveryIssues.filter(
    (issue) => issue.severity === "Medium"
  ).length;

  function reviewRecoveryBooking(booking: Booking) {
    setActivePage("Bookings");
    setSearchQuery(booking.id);
    setStatusFilter("All statuses");
    setAssignmentFilter("All bookings");
    setError("");
    setNotice("");
    void openEditBooking(booking);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <div className="brand-name">RideFlow</div>
            <div className="brand-caption">OPERATIONS PLATFORM</div>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="navigation">
          {navigation.map((item) => (
            <button
              className={`nav-item ${activePage === item.name ? "active" : ""}`}
              key={item.name}
              type="button"
              onClick={() => {
                setActivePage(item.name);
                setError("");
                setNotice("");

                if (
                  item.name === "Drivers" ||
                  item.name === "Dashboard" ||
                  item.name === "Smart Recovery"
                ) {
                  void loadDrivers().catch(() => {});
                }

                if (item.name === "Bookings") {
                  setAssignmentFilter("All bookings");
                  setStatusFilter("All statuses");
                  setSearchQuery("");
                }

                if (item.name === "Routes") {
                  void loadBookings();
                }
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.name}</span>

              {item.name === "Bookings" && bookings.length > 0 && (
                <span className="nav-count">{bookings.length}</span>
              )}

              {item.name === "Drivers" && drivers.length > 0 && (
                <span className="nav-count">{drivers.length}</span>
              )}

              {item.name === "Smart Recovery" && recoveryIssues.length > 0 && (
                <span className="nav-count">{recoveryIssues.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="online-indicator">
            <span className="online-dot" />
            API connection
            <span className="online-label">LIVE</span>
          </div>

          <div className="profile">
            <div className="avatar">RF</div>
            <div className="profile-copy">
              <strong>RideFlow Admin</strong>
              <span>Administrator</span>
            </div>
            <span className="profile-menu">···</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{activePage}</strong>
          </div>

          <div className="topbar-right">
            <span className="today-label">
              {new Date().toLocaleDateString("en-GB", {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
            <div className="top-avatar">RF</div>
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">PRIVATE HIRE MANAGEMENT</div>
              <h1>{activePage}</h1>
              <p className="page-subtitle">
                {activePage === "Dashboard"
                  ? "Manage your bookings and daily operations."
                  : activePage === "Bookings"
                    ? "View and manage all your private hire bookings."
                    : activePage === "Drivers"
                      ? "View your saved drivers and their current availability."
                      : activePage === "Routes"
                        ? "Review journey pickup and destination details."
                        : "Review bookings that may need attention."}
              </p>
            </div>

            {activePage === "Drivers" ? (
              <button
                className="primary-button"
                type="button"
                onClick={openAddDriver}
              >
                <span className="button-plus">+</span>
                Add driver
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                onClick={() => void openNewBooking()}
              >
                <span className="button-plus">+</span>
                New booking
              </button>
            )}
          </div>

          {error && (
            <div className="alert alert-error" role="alert">
              <span>!</span>
              {error}
              <button type="button" onClick={() => setError("")}>
                Dismiss
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

          {activePage === "Dashboard" && (
            <section className="stats-grid">
              <article
                className="stat-card"
                role="button"
                tabIndex={0}
                aria-label="Open all bookings"
                title="Click to view all bookings"
                style={{ cursor: "pointer" }}
                onClick={() => openBookingsWithFilters()}
                onKeyDown={(event) =>
                  handleCardKeyDown(event, () => openBookingsWithFilters())
                }
              >
                <div className="stat-top">
                  <span className="stat-label">Total bookings</span>
                  <span className="stat-icon icon-purple">▤</span>
                </div>
                <div className="stat-number">
                  {loading ? "—" : totalBookings}
                </div>
                <div className="stat-foot">All bookings in your system</div>
              </article>

              <article
                className="stat-card"
                role="button"
                tabIndex={0}
                aria-label="Open confirmed bookings"
                title="Click to view confirmed bookings"
                style={{ cursor: "pointer" }}
                onClick={() => openBookingsWithFilters("Confirmed")}
                onKeyDown={(event) =>
                  handleCardKeyDown(event, () =>
                    openBookingsWithFilters("Confirmed")
                  )
                }
              >
                <div className="stat-top">
                  <span className="stat-label">Confirmed</span>
                  <span className="stat-icon icon-green">✓</span>
                </div>
                <div className="stat-number">
                  {loading ? "—" : confirmedBookings}
                </div>
                <div className="stat-foot">Bookings marked confirmed</div>
              </article>

              <article
                className="stat-card"
                role="button"
                tabIndex={0}
                aria-label="Open unassigned bookings"
                title="Click to view bookings without a driver"
                style={{ cursor: "pointer" }}
                onClick={() =>
                  openBookingsWithFilters("All statuses", "Unassigned")
                }
                onKeyDown={(event) =>
                  handleCardKeyDown(event, () =>
                    openBookingsWithFilters("All statuses", "Unassigned")
                  )
                }
              >
                <div className="stat-top">
                  <span className="stat-label">Unassigned</span>
                  <span className="stat-icon icon-orange">♙</span>
                </div>
                <div className="stat-number">
                  {loading ? "—" : unassignedBookings}
                </div>
                <div className="stat-foot">Need a driver assignment</div>
              </article>

              <article
                className="stat-card"
                role="button"
                tabIndex={0}
                aria-label="Open bookings with assigned drivers"
                title="Click to view bookings with an assigned driver"
                style={{ cursor: "pointer" }}
                onClick={() =>
                  openBookingsWithFilters("All statuses", "Assigned")
                }
                onKeyDown={(event) =>
                  handleCardKeyDown(event, () =>
                    openBookingsWithFilters("All statuses", "Assigned")
                  )
                }
              >
                <div className="stat-top">
                  <span className="stat-label">Drivers assigned</span>
                  <span className="stat-icon icon-blue">↗</span>
                </div>
                <div className="stat-number">
                  {loading ? "—" : assignedDrivers}
                </div>
                <div className="stat-foot">Distinct assigned drivers</div>
              </article>

              <article
                className="stat-card"
                role="button"
                tabIndex={0}
                aria-label="Open drivers page"
                title="Click to view drivers"
                style={{ cursor: "pointer" }}
                onClick={openDriversPage}
                onKeyDown={(event) =>
                  handleCardKeyDown(event, openDriversPage)
                }
              >
                <div className="stat-top">
                  <span className="stat-label">Available Drivers</span>
                  <span className="stat-icon icon-green">✓</span>
                </div>
                <div className="stat-number">
                  {driversLoading ? "—" : availableDrivers}
                </div>
                <div className="stat-foot">Ready for assignment</div>
              </article>
            </section>
          )}

          {activePage === "Drivers" && (
            <>
              <section className="stats-grid driver-stats-grid">
                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-label">Total drivers</span>
                    <span className="stat-icon icon-purple">♙</span>
                  </div>
                  <div className="stat-number">
                    {driversLoading ? "—" : drivers.length}
                  </div>
                  <div className="stat-foot">Saved in your database</div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-label">Available</span>
                    <span className="stat-icon icon-green">✓</span>
                  </div>
                  <div className="stat-number">
                    {driversLoading ? "—" : availableDrivers}
                  </div>
                  <div className="stat-foot">Ready for assignment</div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-label">Busy</span>
                    <span className="stat-icon icon-orange">◷</span>
                  </div>
                  <div className="stat-number">
                    {driversLoading ? "—" : busyDrivers}
                  </div>
                  <div className="stat-foot">Currently assigned</div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-label">Unavailable</span>
                    <span className="stat-icon icon-blue">—</span>
                  </div>
                  <div className="stat-number">
                    {driversLoading ? "—" : unavailableDrivers}
                  </div>
                  <div className="stat-foot">Not available for assignment</div>
                </article>
              </section>

              <section className="bookings-panel">
                <div className="section-heading">
                  <div>
                    <h2>Saved drivers</h2>
                    <p>
                      Driver details and availability from your existing
                      database.
                    </p>
                  </div>

                  <button
                    className="secondary-button"
                    type="button"
                    disabled={driversLoading}
                    onClick={() => void loadDrivers().catch(() => {})}
                  >
                    {driversLoading ? "Loading…" : "↻ Refresh"}
                  </button>
                </div>

                {driverError && (
                  <div className="alert alert-error" role="alert">
                    <span>!</span>
                    {driverError}
                    <button
                      type="button"
                      onClick={() => void loadDrivers().catch(() => {})}
                    >
                      Retry
                    </button>
                  </div>
                )}

                {driversLoading && drivers.length === 0 ? (
                  <div className="table-message">Loading drivers…</div>
                ) : drivers.length === 0 ? (
                  <div className="table-message">
                    No saved drivers were returned by the API. If you have
                    already added drivers, check the backend connection and
                    click Refresh.
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="bookings-table">
                      <thead>
                        <tr>
                          <th>DRIVER</th>
                          <th>PHONE</th>
                          <th>VEHICLE</th>
                          <th>REGISTRATION</th>
                          <th>AVAILABILITY</th>
                          <th>ACTION</th>
                        </tr>
                      </thead>

                      <tbody>
                        {drivers.map((driver) => (
                          <tr key={driver.id}>
                            <td className="passenger-cell">{driver.name}</td>
                            <td>{driver.phone || "—"}</td>
                            <td>{driver.vehicle_model || "—"}</td>
                            <td>{driver.vehicle_registration || "—"}</td>
                            <td>
                              <select
                                className="driver-availability-select"
                                aria-label={`Availability for ${driver.name}`}
                                value={driver.availability}
                                disabled={savingDriverId === driver.id}
                                onChange={(event) => {
                                  const availability = event.target.value;

                                  setDrivers((current) =>
                                    current.map((item) =>
                                      item.id === driver.id
                                        ? { ...item, availability }
                                        : item
                                    )
                                  );
                                }}
                              >
                                <option value="Available">Available</option>
                                <option value="Busy">Busy</option>
                                <option value="Unavailable">Unavailable</option>
                              </select>
                            </td>
                            <td>
                              <button
                                className="secondary-button driver-save-button"
                                type="button"
                                disabled={savingDriverId === driver.id}
                                onClick={() =>
                                  void saveDriverAvailability(driver)
                                }
                              >
                                {savingDriverId === driver.id
                                  ? "Saving…"
                                  : "Save"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="table-footer">
                  <span>
                    {drivers.length} saved{" "}
                    {drivers.length === 1 ? "driver" : "drivers"}
                  </span>
                  <span>RideFlow database</span>
                </div>
              </section>
            </>
          )}

          {activePage === "Smart Recovery" && (
            <>
              <section className="stats-grid">
                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-label">Bookings to review</span>
                    <span className="stat-icon icon-purple">✧</span>
                  </div>
                  <div className="stat-number">{recoveryIssues.length}</div>
                  <div className="stat-foot">
                    Bookings flagged by recovery checks
                  </div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-label">High priority</span>
                    <span className="stat-icon icon-orange">!</span>
                  </div>
                  <div className="stat-number">{highPriorityRecoveries}</div>
                  <div className="stat-foot">
                    Issues that may need prompt attention
                  </div>
                </article>

                <article className="stat-card">
                  <div className="stat-top">
                    <span className="stat-label">Other issues</span>
                    <span className="stat-icon icon-blue">◷</span>
                  </div>
                  <div className="stat-number">{mediumPriorityRecoveries}</div>
                  <div className="stat-foot">Additional checks to review</div>
                </article>
              </section>

              <section className="bookings-panel">
                <div className="section-heading">
                  <div>
                    <h2>Recovery review</h2>
                    <p>
                      These rule-based checks highlight bookings that may need
                      attention. Review each item before changing a booking.
                    </p>
                  </div>

                  <button
                    className="secondary-button"
                    type="button"
                    disabled={loading || driversLoading}
                    onClick={() => {
                      void loadBookings();
                      void loadDrivers().catch(() => {});
                    }}
                  >
                    ↻ Refresh
                  </button>
                </div>

                {loading || driversLoading ? (
                  <div className="table-message">
                    Checking bookings and driver availability…
                  </div>
                ) : recoveryIssues.length === 0 ? (
                  <div className="table-message">
                    No issues were found by the current recovery checks.
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="bookings-table">
                      <thead>
                        <tr>
                          <th>PRIORITY</th>
                          <th>REFERENCE</th>
                          <th>PASSENGER</th>
                          <th>PICKUP TIME</th>
                          <th>DRIVER</th>
                          <th>REASON</th>
                          <th>ACTION</th>
                        </tr>
                      </thead>

                      <tbody>
                        {recoveryIssues.map((issue) => (
                          <tr key={issue.booking.id}>
                            <td>
                              <span
                                className={`status-pill ${
                                  issue.severity === "High"
                                    ? "status-at-risk"
                                    : "status-pending"
                                }`}
                              >
                                <span className="status-dot" />
                                {issue.severity}
                              </span>
                            </td>
                            <td>
                              <span className="reference">
                                {issue.booking.id}
                              </span>
                            </td>
                            <td className="passenger-cell">
                              {issue.booking.passenger || "—"}
                            </td>
                            <td className="time-cell">
                              {issue.booking.time
                                ? issue.booking.time
                                    .replace("T", " ")
                                    .slice(0, 16)
                                : "—"}
                            </td>
                            <td>{issue.booking.driver || "Unassigned"}</td>
                            <td>
                              <ul className="recovery-reasons">
                                {issue.reasons.map((reason) => (
                                  <li key={reason}>{reason}</li>
                                ))}
                              </ul>
                            </td>
                            <td>
                              <button
                                className="secondary-button"
                                type="button"
                                onClick={() =>
                                  reviewRecoveryBooking(issue.booking)
                                }
                              >
                                Review booking
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="table-footer">
                  <span>
                    {recoveryIssues.length}{" "}
                    {recoveryIssues.length === 1
                      ? "booking flagged"
                      : "bookings flagged"}
                  </span>
                  <span>Recommendations require operator review</span>
                </div>
              </section>
            </>
          )}

          {activePage === "Routes" && (
            <section className="bookings-panel">
              <div className="section-heading">
                <div>
                  <h2>Journey routes</h2>
                  <p>
                    Review saved pickup and destination details for your
                    bookings.
                  </p>
                </div>

                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void loadBookings()}
                >
                  ↻ Refresh
                </button>
              </div>

              {loading ? (
                <div className="table-message">Loading journeys…</div>
              ) : bookings.length === 0 ? (
                <div className="table-message">
                  No bookings are available to display.
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="bookings-table">
                    <thead>
                      <tr>
                        <th>REFERENCE</th>
                        <th>PASSENGER</th>
                        <th>PICKUP</th>
                        <th>DESTINATION</th>
                        <th>TIME</th>
                        <th>DRIVER</th>
                        <th>STATUS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bookings.map((booking) => (
                        <tr key={booking.id}>
                          <td>
                            <span className="reference">{booking.id}</span>
                          </td>
                          <td className="passenger-cell">
                            {booking.passenger || "—"}
                          </td>
                          <td className="address-cell">
                            {booking.pickup || "—"}
                          </td>
                          <td className="address-cell">
                            {booking.destination || "—"}
                          </td>
                          <td className="time-cell">
                            {booking.time
                              ? booking.time.replace("T", " ").slice(0, 16)
                              : "—"}
                          </td>
                          <td>{booking.driver || "Unassigned"}</td>
                          <td>
                            <span
                              className={`status-pill ${getStatusClass(
                                booking.status
                              )}`}
                            >
                              <span className="status-dot" />
                              {booking.status || "Unassigned"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="table-footer">
                <span>{bookings.length} saved journeys</span>
                <span>RideFlow database</span>
              </div>
            </section>
          )}

          {(activePage === "Dashboard" || activePage === "Bookings") && (
            <section className="bookings-panel">
              <div className="section-heading">
                <div>
                  <h2>
                    {activePage === "Dashboard"
                      ? "Recent bookings"
                      : "Bookings"}
                  </h2>
                  <p>Bookings loaded from your existing database.</p>
                </div>

                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void loadBookings()}
                >
                  ↻ Refresh
                </button>
              </div>

              <div className="form-grid additional-fields">
                <label className="field">
                  <span>Search bookings</span>
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Reference, passenger, pickup or destination"
                  />
                </label>

                <label className="field">
                  <span>Filter by status</span>
                  <select
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    <option value="All statuses">All statuses</option>
                    {bookingStatuses.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Filter by driver assignment</span>
                  <select
                    value={assignmentFilter}
                    onChange={(event) =>
                      setAssignmentFilter(
                        event.target.value as AssignmentFilter
                      )
                    }
                  >
                    <option value="All bookings">All bookings</option>
                    <option value="Assigned">Assigned</option>
                    <option value="Unassigned">Unassigned</option>
                  </select>
                </label>
              </div>

              <div className="table-wrap">
                <table className="bookings-table">
                  <thead>
                    <tr>
                      <th>REFERENCE</th>
                      <th>PASSENGER</th>
                      <th>PHONE</th>
                      <th>PICKUP</th>
                      <th>DESTINATION</th>
                      <th>TIME</th>
                      <th>DRIVER</th>
                      <th>STATUS</th>
                    </tr>
                  </thead>

                  <tbody>
                    {loading ? (
                      <tr>
                        <td className="table-message" colSpan={8}>
                          Loading bookings…
                        </td>
                      </tr>
                    ) : filteredBookings.length === 0 ? (
                      <tr>
                        <td className="table-message" colSpan={8}>
                          {bookings.length === 0
                            ? "No bookings found. Click New booking to add one."
                            : "No bookings match your search or selected filters."}
                        </td>
                      </tr>
                    ) : (
                      filteredBookings.map((booking) => (
                        <tr
                          key={booking.id}
                          onClick={() => void openEditBooking(booking)}
                          style={{ cursor: "pointer" }}
                          title="Click to edit this booking"
                        >
                          <td>
                            <span className="reference">{booking.id}</span>
                          </td>
                          <td className="passenger-cell">
                            {booking.passenger || "—"}
                          </td>
                          <td>{booking.phone || "—"}</td>
                          <td className="address-cell">
                            {booking.pickup || "—"}
                          </td>
                          <td className="address-cell">
                            {booking.destination || "—"}
                          </td>
                          <td className="time-cell">
                            {booking.time
                              ? booking.time.replace("T", " ").slice(0, 16)
                              : "—"}
                          </td>
                          <td>{booking.driver || "Unassigned"}</td>
                          <td className="status-cell">
                            <span
                              className={`status-pill ${getStatusClass(
                                booking.status || "Unassigned"
                              )}`}
                            >
                              <span className="status-dot" />
                              {booking.status || "Unassigned"}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="table-footer">
                <span>
                  Showing {filteredBookings.length} of {bookings.length}{" "}
                  {bookings.length === 1 ? "booking" : "bookings"}
                </span>
                <span>RideFlow database</span>
              </div>
            </section>
          )}

          <footer className="page-footer">
            <span>RideFlow © {new Date().getFullYear()}</span>
            <span>Private hire booking dashboard</span>
          </footer>
        </div>
      </main>

      {modalOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) {
              setModalOpen(false);
            }
          }}
        >
          <section
            className="booking-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">BOOKING MANAGEMENT</div>
                <h2 id="booking-modal-title">
                  {editingBookingId ? "Edit booking" : "Create a new booking"}
                </h2>
                <p>
                  {editingBookingId
                    ? "Update the booking details or change its status below."
                    : "Enter the passenger and journey details below."}
                </p>
              </div>

              <button
                className="close-button"
                type="button"
                aria-label="Close"
                disabled={saving}
                onClick={() => setModalOpen(false)}
              >
                ×
              </button>
            </div>

            <form className="booking-form" onSubmit={handleSaveBooking}>
              <div className="form-section-title">Passenger details</div>

              <div className="form-grid">
                <label className="field">
                  <span>Passenger name *</span>
                  <input
                    required
                    value={form.passenger}
                    onChange={(event) =>
                      updateForm("passenger", event.target.value)
                    }
                    placeholder="Enter passenger name"
                  />
                </label>

                <label className="field">
                  <span>Phone number *</span>
                  <input
                    required
                    type="tel"
                    value={form.phone}
                    onChange={(event) =>
                      updateForm("phone", event.target.value)
                    }
                    placeholder="e.g. 07123456789"
                  />
                </label>
              </div>

              <div className="form-section-title journey-title">
                Journey details
              </div>

              <div className="address-fields">
                <AddressAutocomplete
                  label="Pickup location"
                  value={form.pickup}
                  onChange={(value) => updateForm("pickup", value)}
                  placeholder="Enter postcode or pickup address"
                  required
                />

                <AddressAutocomplete
                  label="Destination"
                  value={form.destination}
                  onChange={(value) => updateForm("destination", value)}
                  placeholder="Enter postcode or destination address"
                  required
                />
              </div>

              <div className="form-grid additional-fields">
                <label className="field">
                  <span>Pickup date and time *</span>
                  <input
                    required
                    type="datetime-local"
                    value={form.time}
                    onChange={(event) =>
                      updateForm("time", event.target.value)
                    }
                  />
                </label>

                <label className="field">
                  <span>Driver</span>
                  <select
                    value={
                      form.driver.trim().toLowerCase() === "unassigned"
                        ? ""
                        : (
                            drivers.find(
                              (driver) =>
                                driver.name.trim().toLowerCase() ===
                                form.driver.trim().toLowerCase()
                            )?.name ?? form.driver
                          )
                    }
                    onChange={(event) =>
                      updateForm("driver", event.target.value || "Unassigned")
                    }
                  >
                    <option value="">Unassigned</option>

                    {form.driver.trim() &&
                      form.driver.trim().toLowerCase() !== "unassigned" &&
                      !drivers.some(
                        (driver) =>
                          driver.name.trim().toLowerCase() ===
                          form.driver.trim().toLowerCase()
                      ) && (
                        <option value={form.driver}>
                          {form.driver} (currently assigned; not in driver list)
                        </option>
                      )}

                    {drivers.map((driver) => {
                      const availability =
                        driver.availability.trim().toLowerCase();

                      const isCurrentDriver =
                        driver.name.trim().toLowerCase() ===
                        form.driver.trim().toLowerCase();

                      const vehicle = [
                        driver.vehicle_model,
                        driver.vehicle_registration,
                      ]
                        .filter(Boolean)
                        .join(" · ");

                      const isAvailable = availability === "available";
                      const selectable = isAvailable || isCurrentDriver;

                      return (
                        <option
                          key={driver.id}
                          value={driver.name}
                          disabled={!selectable}
                        >
                          {driver.name}
                          {vehicle ? ` — ${vehicle}` : ""}
                          {` — ${driver.availability || "Unknown"}`}
                          {!isAvailable
                            ? " (not available for new assignments)"
                            : ""}
                        </option>
                      );
                    })}
                  </select>

                  <small>
                    Availability is refreshed when the form opens. Busy and
                    unavailable drivers cannot be newly assigned.
                  </small>
                </label>
              </div>

              <label className="field status-field">
                <span>Booking status</span>
                <select
                  value={form.status}
                  onChange={(event) =>
                    updateForm("status", event.target.value)
                  }
                >
                  <option value="Unassigned">Unassigned</option>
                  <option value="Confirmed">Confirmed</option>
                  <option value="At risk">At risk</option>
                </select>
              </label>

              <div className="modal-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving}
                  onClick={() => setModalOpen(false)}
                >
                  Cancel
                </button>

                <button
                  className="primary-button"
                  type="submit"
                  disabled={saving}
                >
                  {saving
                    ? "Saving…"
                    : editingBookingId
                      ? "Save changes"
                      : "Save booking"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {driverModalOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !savingNewDriver
            ) {
              setDriverModalOpen(false);
            }
          }}
        >
          <section
            className="booking-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="driver-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">DRIVER MANAGEMENT</div>
                <h2 id="driver-modal-title">Add a driver</h2>
                <p>Enter the driver's contact and vehicle details.</p>
              </div>

              <button
                className="close-button"
                type="button"
                aria-label="Close"
                disabled={savingNewDriver}
                onClick={() => setDriverModalOpen(false)}
              >
                ×
              </button>
            </div>

            <form className="booking-form" onSubmit={handleSaveDriver}>
              <div className="form-section-title">Driver details</div>

              <div className="form-grid">
                <label className="field">
                  <span>Driver name *</span>
                  <input
                    required
                    autoFocus
                    value={newDriver.name}
                    onChange={(event) =>
                      setNewDriver((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="Enter driver's full name"
                  />
                </label>

                <label className="field">
                  <span>Phone number</span>
                  <input
                    type="tel"
                    value={newDriver.phone}
                    onChange={(event) =>
                      setNewDriver((current) => ({
                        ...current,
                        phone: event.target.value,
                      }))
                    }
                    placeholder="Enter phone number"
                  />
                </label>

                <label className="field">
                  <span>Vehicle model</span>
                  <input
                    value={newDriver.vehicle_model}
                    onChange={(event) =>
                      setNewDriver((current) => ({
                        ...current,
                        vehicle_model: event.target.value,
                      }))
                    }
                    placeholder="e.g. Toyota Prius"
                  />
                </label>

                <label className="field">
                  <span>Vehicle registration</span>
                  <input
                    value={newDriver.vehicle_registration}
                    onChange={(event) =>
                      setNewDriver((current) => ({
                        ...current,
                        vehicle_registration: event.target.value.toUpperCase(),
                      }))
                    }
                    placeholder="e.g. AB12 CDE"
                  />
                </label>
              </div>

              <label className="field status-field">
                <span>Availability</span>
                <select
                  value={newDriver.availability}
                  onChange={(event) =>
                    setNewDriver((current) => ({
                      ...current,
                      availability: event.target.value,
                    }))
                  }
                >
                  <option value="Available">Available</option>
                  <option value="Busy">Busy</option>
                  <option value="Unavailable">Unavailable</option>
                </select>
              </label>

              {driverError && (
                <div className="alert alert-error" role="alert">
                  <span>!</span>
                  {driverError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={savingNewDriver}
                  onClick={() => setDriverModalOpen(false)}
                >
                  Cancel
                </button>

                <button
                  className="primary-button"
                  type="submit"
                  disabled={savingNewDriver}
                >
                  {savingNewDriver ? "Saving…" : "Save driver"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
