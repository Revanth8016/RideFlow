require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = 3001;
const API_KEY = process.env.IDEAL_POSTCODES_API_KEY;
const API_BASE = 'https://api.ideal-postcodes.co.uk/v1';

app.use(express.json());

const db = new Database(path.join(__dirname, 'rideflow.db'));
db.pragma('journal_mode = WAL');

// ---------------- DATABASE ----------------

db.exec(`
CREATE TABLE IF NOT EXISTS bookings (
 id TEXT PRIMARY KEY,
 passenger TEXT NOT NULL,
 phone TEXT NOT NULL DEFAULT '',
 pickup TEXT NOT NULL,
 destination TEXT NOT NULL,
 time TEXT NOT NULL,
 driver TEXT NOT NULL DEFAULT 'Unassigned',
 status TEXT NOT NULL DEFAULT 'Unassigned',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drivers (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 phone TEXT NOT NULL DEFAULT '',
 vehicle_model TEXT NOT NULL DEFAULT '',
 vehicle_registration TEXT NOT NULL DEFAULT '',
 availability TEXT NOT NULL DEFAULT 'Available',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// Add the manual override column without deleting existing data.
const driverColumns = db.prepare(
  'PRAGMA table_info(drivers)'
).all();

if (!driverColumns.some(column => column.name === 'availability_manual')) {
  db.exec(`
    ALTER TABLE drivers
    ADD COLUMN availability_manual INTEGER NOT NULL DEFAULT 0
  `);
}

const allowedStatuses = ['Confirmed', 'At risk', 'Unassigned'];
const allowedAvailability = ['Available', 'Busy', 'Unavailable'];

// ---------------- PREPARED STATEMENTS ----------------

const getBookings = db.prepare(`
 SELECT id, passenger, phone, pickup, destination, time, driver, status
 FROM bookings
 ORDER BY created_at DESC, rowid DESC
`);

const getBooking = db.prepare(`
 SELECT id, passenger, phone, pickup, destination, time, driver, status
 FROM bookings WHERE id = ?
`);

const insertBooking = db.prepare(`
 INSERT INTO bookings
 (id, passenger, phone, pickup, destination, time, driver, status)
 VALUES
 (@id, @passenger, @phone, @pickup, @destination, @time, @driver, @status)
`);

const updateBooking = db.prepare(`
 UPDATE bookings
 SET passenger=@passenger, phone=@phone, pickup=@pickup,
     destination=@destination, time=@time, driver=@driver, status=@status
 WHERE id=@id
`);

const getDrivers = db.prepare(`
 SELECT id, name, phone, vehicle_model, vehicle_registration, availability
 FROM drivers
 ORDER BY created_at DESC, rowid DESC
`);

const getDriver = db.prepare(`
 SELECT id, name, phone, vehicle_model, vehicle_registration, availability
 FROM drivers WHERE id = ?
`);

const getDriverByName = db.prepare(`
 SELECT id, name, phone, vehicle_model, vehicle_registration,
        availability, availability_manual
 FROM drivers WHERE LOWER(name) = LOWER(?)
`);

const getDriverWithOverride = db.prepare(`
 SELECT id, name, phone, vehicle_model, vehicle_registration,
        availability, availability_manual
 FROM drivers WHERE id = ?
`);

const insertDriver = db.prepare(`
 INSERT INTO drivers
 (id, name, phone, vehicle_model, vehicle_registration,
  availability, availability_manual)
 VALUES
 (@id, @name, @phone, @vehicle_model, @vehicle_registration,
  @availability, @availability_manual)
`);

const updateDriver = db.prepare(`
 UPDATE drivers
 SET name=@name, phone=@phone, vehicle_model=@vehicle_model,
     vehicle_registration=@vehicle_registration,
     availability=@availability,
     availability_manual=@availability_manual
 WHERE id=@id
`);

const setDriverAvailability = db.prepare(`
 UPDATE drivers SET availability = ? WHERE id = ?
`);

const getBookingsForDriver = db.prepare(`
 SELECT id, status FROM bookings
 WHERE LOWER(driver) = LOWER(?)
`);

// ---------------- DRIVER AVAILABILITY ----------------

/**
 * Only automatically recalculate availability if the driver has
 * not explicitly selected a manual availability override.
 */
function refreshDriverAvailability(driverName) {
  const name = String(driverName || '').trim();

  if (!name || name.toLowerCase() === 'unassigned') {
    return;
  }

  const driver = getDriverByName.get(name);

  if (!driver) {
    return;
  }

  // Manual selections always take priority.
  if (Number(driver.availability_manual) === 1) {
    return;
  }

  // Preserve the existing rule for unavailable drivers.
  if (driver.availability === 'Unavailable') {
    return;
  }

  const hasActiveBooking = getBookingsForDriver.all(name).some(
    booking => booking.status !== 'Unassigned'
  );

  setDriverAvailability.run(
    hasActiveBooking ? 'Busy' : 'Available',
    driver.id
  );
}

// ---------------- BOOKING TRANSACTIONS ----------------

const createBookingTransaction = db.transaction(booking => {
  insertBooking.run(booking);

  if (booking.driver !== 'Unassigned') {
    refreshDriverAvailability(booking.driver);
  }
});

const updateBookingTransaction = db.transaction((booking, previousDriver) => {
  updateBooking.run(booking);

  if (previousDriver && previousDriver.toLowerCase() !== 'unassigned') {
    refreshDriverAvailability(previousDriver);
  }

  if (booking.driver && booking.driver.toLowerCase() !== 'unassigned') {
    refreshDriverAvailability(booking.driver);
  }
});

const assignBookingTransaction = db.transaction(
  (booking, previousDriver, driver) => {
    const currentDriver = getDriver.get(driver.id);

    if (!currentDriver || currentDriver.availability !== 'Available') {
      const error = new Error(
        'This driver is no longer available. Refresh the list and choose another driver.'
      );
      error.statusCode = 409;
      throw error;
    }

    updateBooking.run(booking);

    if (previousDriver && previousDriver.toLowerCase() !== 'unassigned') {
      refreshDriverAvailability(previousDriver);
    }

    refreshDriverAvailability(currentDriver.name);
  }
);

// ---------------- HEALTH ----------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'RideFlow API',
    database: 'connected'
  });
});

// ---------------- BOOKINGS ----------------

app.get('/api/bookings', (req, res) => {
  try {
    res.json(getBookings.all());
  } catch (error) {
    console.error('Load bookings error:', error);
    res.status(500).json({ error: 'Could not load bookings.' });
  }
});

app.post('/api/bookings', (req, res) => {
  try {
    const body = req.body || {};

    const passenger = String(body.passenger || '').trim();
    const phone = String(body.phone || '').trim();
    const pickup = String(body.pickup || '').trim();
    const destination = String(body.destination || '').trim();
    const time = String(body.time || '').trim();

    if (!passenger || !pickup || !destination || !time) {
      return res.status(400).json({
        error: 'Passenger, pickup, destination and time are required.'
      });
    }

    const requestedStatus = String(body.status || 'Unassigned').trim();
    const status = allowedStatuses.includes(requestedStatus)
      ? requestedStatus
      : 'Unassigned';

    const id = body.id
      ? String(body.id).trim()
      : `RF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    if (!id) {
      return res.status(400).json({ error: 'Booking ID is required.' });
    }

    const requestedDriver = String(body.driver || 'Unassigned').trim();
    const driver = status === 'Unassigned'
      ? 'Unassigned'
      : requestedDriver || 'Unassigned';

    const booking = {
      id,
      passenger,
      phone,
      pickup,
      destination,
      time,
      driver,
      status
    };

    createBookingTransaction(booking);

    res.status(201).json(getBooking.get(id));
  } catch (error) {
    console.error('Save booking error:', error);

    if (
      error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      return res.status(409).json({
        error: 'This booking ID already exists.'
      });
    }

    res.status(500).json({ error: 'Could not save booking.' });
  }
});

app.put('/api/bookings/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const old = getBooking.get(id);

    if (!old) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const b = req.body || {};

    const passenger = b.passenger === undefined
      ? old.passenger
      : String(b.passenger || '').trim();

    const phone = b.phone === undefined
      ? old.phone
      : String(b.phone || '').trim();

    const pickup = b.pickup === undefined
      ? old.pickup
      : String(b.pickup || '').trim();

    const destination = b.destination === undefined
      ? old.destination
      : String(b.destination || '').trim();

    const time = b.time === undefined
      ? old.time
      : String(b.time || '').trim();

    const status = b.status === undefined
      ? old.status
      : String(b.status || '').trim();

    if (!passenger || !pickup || !destination || !time) {
      return res.status(400).json({
        error: 'Passenger, pickup, destination and time are required.'
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status. Choose Confirmed, At risk or Unassigned.'
      });
    }

    const requestedDriver = b.driver === undefined
      ? old.driver
      : String(b.driver || 'Unassigned').trim();

    const driver = status === 'Unassigned'
      ? 'Unassigned'
      : requestedDriver || 'Unassigned';

    const booking = {
      id,
      passenger,
      phone,
      pickup,
      destination,
      time,
      driver,
      status
    };

    if (b.assignDriverId !== undefined) {
      const driverId = String(b.assignDriverId || '').trim();
      const selectedDriver = getDriver.get(driverId);

      if (!selectedDriver) {
        return res.status(400).json({
          error: 'The selected driver was not found.'
        });
      }

      if (selectedDriver.availability !== 'Available') {
        return res.status(409).json({
          error: 'This driver is no longer available. Refresh the list and choose another driver.'
        });
      }

      booking.driver = selectedDriver.name;
      booking.status = 'Confirmed';

      assignBookingTransaction(booking, old.driver, selectedDriver);
    } else {
      updateBookingTransaction(booking, old.driver);
    }

    res.json(getBooking.get(id));
  } catch (error) {
    console.error('Update booking error:', error);

    if (error.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }

    res.status(500).json({ error: 'Could not update booking.' });
  }
});

// ---------------- DRIVERS ----------------

app.get('/api/drivers', (req, res) => {
  try {
    res.json(getDrivers.all());
  } catch (error) {
    console.error('Load drivers error:', error);
    res.status(500).json({ error: 'Could not load drivers.' });
  }
});

app.post('/api/drivers', (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();

    if (!name) {
      return res.status(400).json({
        error: 'Driver name is required.'
      });
    }

    const availability = String(b.availability || 'Available').trim();

    if (!allowedAvailability.includes(availability)) {
      return res.status(400).json({
        error: 'Choose Available, Busy or Unavailable.'
      });
    }

    const driver = {
      id: `DRV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      phone: String(b.phone || '').trim(),
      vehicle_model: String(b.vehicle_model || '').trim(),
      vehicle_registration: String(b.vehicle_registration || '')
        .trim()
        .toUpperCase(),
      availability,
      availability_manual: 1
    };

    insertDriver.run(driver);

    res.status(201).json(getDriver.get(driver.id));
  } catch (error) {
    console.error('Create driver error:', error);
    res.status(500).json({ error: 'Could not save driver.' });
  }
});

app.put('/api/drivers/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = getDriverWithOverride.get(id);

    if (!existing) {
      return res.status(404).json({
        error: 'Driver not found.'
      });
    }

    const b = req.body || {};
    const availabilityWasProvided = b.availability !== undefined;

    const driver = {
      id,
      name: b.name === undefined
        ? existing.name
        : String(b.name || '').trim(),
      phone: b.phone === undefined
        ? existing.phone
        : String(b.phone || '').trim(),
      vehicle_model: b.vehicle_model === undefined
        ? existing.vehicle_model
        : String(b.vehicle_model || '').trim(),
      vehicle_registration: b.vehicle_registration === undefined
        ? existing.vehicle_registration
        : String(b.vehicle_registration || '').trim().toUpperCase(),
      availability: availabilityWasProvided
        ? String(b.availability || '').trim()
        : existing.availability,
      availability_manual: availabilityWasProvided
        ? 1
        : Number(existing.availability_manual) || 0
    };

    if (!driver.name) {
      return res.status(400).json({
        error: 'Driver name is required.'
      });
    }

    if (!allowedAvailability.includes(driver.availability)) {
      return res.status(400).json({
        error: 'Choose Available, Busy or Unavailable.'
      });
    }

    updateDriver.run(driver);

    // If the name changes, update the previous driver's automatic
    // availability only when that driver's status is not manually locked.
    if (existing.name.toLowerCase() !== driver.name.toLowerCase()) {
      refreshDriverAvailability(existing.name);
    }

    // Do not automatically recalculate the updated driver's status.
    res.json(getDriver.get(id));
  } catch (error) {
    console.error('Update driver error:', error);
    res.status(500).json({ error: 'Could not update driver.' });
  }
});

// ---------------- ADDRESS SEARCH ----------------

app.get('/api/address-search', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: 'Missing Ideal Postcodes API key. Check your .env file.'
      });
    }

    const query = String(req.query.q || '').trim();

    if (query.length < 3) {
      return res.json({ suggestions: [] });
    }

    const params = new URLSearchParams({
      api_key: API_KEY,
      query,
      context: 'GBR',
      limit: '8'
    });

    const response = await fetch(
      `${API_BASE}/autocomplete/addresses?${params}`
    );

    const data = await response.json();

    if (!response.ok || data.code !== 2000) {
      console.error('Address search failed:', data.message);
      return res.status(502).json({
        error: data.message || 'Address search failed.'
      });
    }

    res.json({
      suggestions: (data.result?.hits || []).map(item => ({
        id: item.id,
        label: item.suggestion
      }))
    });
  } catch (error) {
    console.error('Address search error:', error);
    res.status(500).json({
      error: 'Could not search addresses.'
    });
  }
});

app.get('/api/address-resolve/:id', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: 'Missing Ideal Postcodes API key. Check your .env file.'
      });
    }

    const params = new URLSearchParams({
      api_key: API_KEY
    });

    const response = await fetch(
      `${API_BASE}/autocomplete/addresses/${encodeURIComponent(req.params.id)}/gbr?${params}`
    );

    const data = await response.json();

    if (!response.ok || data.code !== 2000) {
      console.error('Address lookup failed:', data.message);
      return res.status(502).json({
        error: data.message || 'Could not retrieve the full address.'
      });
    }

    const a = data.result;

    const address = [
      a.line_1,
      a.line_2,
      a.line_3,
      a.post_town,
      a.county,
      a.postcode
    ]
      .filter(Boolean)
      .filter((part, i, all) => all.indexOf(part) === i)
      .join(', ');

    res.json({ address });
  } catch (error) {
    console.error('Address lookup error:', error);
    res.status(500).json({
      error: 'Could not retrieve the address.'
    });
  }
});

// ---------------- START SERVER ----------------

const server = app.listen(PORT, () => {
  console.log(`RideFlow server running at http://localhost:${PORT}`);
  console.log(`SQLite database: ${path.join(__dirname, 'rideflow.db')}`);
});

server.on('error', error => {
  console.error('RideFlow server error:', error);
});

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down RideFlow server...`);

  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));