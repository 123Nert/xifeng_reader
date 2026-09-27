# Debugging I2C: A Field Guide

*Why the bus that "always works" suddenly doesn't, and how to find out why before lunch.*

---

## Introduction

I2C has a reputation problem. On paper it is the friendliest bus in embedded systems: two wires, a handful of pull-up resistors, and an addressing scheme simple enough to explain to an intern. In practice it is the bus most likely to leave you staring at a logic analyzer at 11 p.m. wondering whether the silicon is haunted.

The difficulty is not that I2C is complex. It is that I2C is *forgiving during development and merciless in the field*. A breadboard with three devices and ten centimeters of wire will work with almost any pull-up value you happen to have in the drawer. The same firmware, moved to a production board with longer traces, more capacitance, and a temperature range, will fail once every few hours in a way that no amount of `printf` debugging will explain.

This guide is organized by layer, because that is how the failures actually present themselves. Symptoms that look identical at the application level — a `HAL_I2C_ERROR_TIMEOUT` returned from a sensor read, say — can originate in the silicon, the PCB, the timing budget, or the state machine of your own driver. Guessing at which one is the expensive part.

---

## Layer 1: The Electrical Reality

### Pull-up resistors are not decoration

Every discussion of I2C begins with pull-ups, and for good reason: they are the single most common cause of intermittent failure.

The bus is open-drain. Devices can only pull a line *low*; returning it *high* is the job of the pull-up resistor, working against the capacitance of the wire and every connected pin. The result is an RC curve, and the rise time of that curve must fit inside the clock period or the bus will not be read correctly.

The rule of thumb for standard mode (100 kHz) caps bus capacitance at 400 pF, and for fast mode (400 kHz) at a somewhat smaller budget. A common starting value is 4.7 kΩ. That number is not sacred — it is simply the value that works for the typical combination of a few devices and a short trace. Change either and the number should change with it:

- **More devices on the bus** means more pin capacitance, which means a smaller resistor is needed to keep the rise time acceptable.
- **Smaller resistors** mean more current sunk by every device that pulls the line low. At 3.3 V, a 1 kΩ pull-up asks 3.3 mA of each driver. Check that the weakest device on your bus can actually sink that much while still holding a valid logic low.
- **Lower bus voltage** leaves less headroom. The VIH threshold does not scale with your supply, so a 1.8 V bus needs noticeably stronger pull-ups than a 5 V one.

If you want a quick sanity check without a scope, compute the time constant: `t = R × C`. The 30%–70% rise time of an RC circuit is roughly `0.7 × R × C`, and I2C specifies the rise time as the interval from 0.3 × VDD to 0.7 × VDD. For 4.7 kΩ and 200 pF, that is about 660 ns — comfortable at 100 kHz, marginal at 400 kHz, and fatal at 1 MHz.

### Ground is a wire, not a concept

A surprising number of "I2C problems" are ground problems. If the master and the sensor are on separate boards joined by a ribbon cable, the ground return of that cable carries the supply current of every device on the far side, plus whatever noise the environment injects. The result is a ground potential difference between the two boards, which appears at the receiver as a shift in the logic thresholds.

The fix is not electrical cleverness but topology: keep the ground return adjacent to the signal wires, and do not assume that the shield of a cable is a substitute for a proper return path.

### Capacitance hides in unexpected places

Long traces, ribbon cables, and the input capacitance of every pin add up faster than most engineers expect. A 30 cm ribbon cable can contribute 30–50 pF on its own; a dozen devices on a backplane can push the total past 300 pF before you have laid down a single centimeter of PCB trace.

When in doubt, measure. A cheap LCR meter or even a scope's rise-time measurement will tell you more in five minutes than an hour of datasheet arithmetic.

---

## Layer 2: Timing and Protocol

### The clock is not always yours

Clock stretching exists precisely because some devices need more time than the protocol allows. A sensor performing an internal ADC conversion, an EEPROM completing a write cycle, or a microcontroller with a slow interrupt path may hold SCL low to pause the master.

Plenty of masters — including some hardware peripherals in otherwise excellent microcontrollers — do not implement clock stretching correctly. They drive the clock without checking whether the line is actually high, and the result is a corrupted transfer that appears intermittently.

If your device supports clock stretching, verify that your master honors it. The test is straightforward: hold SCL low deliberately with a GPIO in a test firmware, and confirm that the master waits rather than barreling ahead.

### Repeated start is not optional

Some devices require a repeated start condition (no stop between the address phase and the data phase) rather than a stop-then-start. Register reads on many sensors fall into this category. A driver that issues a stop in the middle will work on some silicon revisions and fail on others, which makes it exactly the kind of bug that escapes to production.

### Arbitration only matters until it doesn't

Multi-master arbitration is elegant in theory: devices that lose arbitration simply stop transmitting and retry later. In practice, a master that loses arbitration must detect the loss and recover its state machine, and the recovery path is frequently untested. If your system has only one master by design, consider whether that assumption is enforced — an external programmer, a debug tool, or a second MCU on the same bus can violate it.

---

## Layer 3: The Firmware You Wrote

### Timeouts are not error handling

The most common pattern in vendor HAL code is a blocking transfer with a timeout measured in milliseconds. When the timeout expires, the function returns an error code, and the application logs it and moves on. This is not error handling; it is error *reporting*.

What the bus actually needs after a failure depends on how the failure occurred:

- If a slave was mid-byte when the master gave up, it may be holding SDA low waiting for a clock edge that never comes. The bus is now stuck, and every subsequent transfer will fail until the slave is clocked out of its state.
- The standard recovery is to issue up to nine clock pulses with SDA released, then a stop condition. Many hardware peripherals cannot do this on their own; it must be done manually by reconfiguring the pins as GPIO.

A robust driver therefore has three distinct paths: the normal transfer, the error return, and the *bus recovery* routine. The third is the one nobody writes until the field failures start.

### State machines that never reset

A driver with a multi-step state machine — read register, write register, read back, verify — can become permanently wedged if one step fails without unwinding the state. The next call enters the machine mid-sequence and produces nonsensical behavior that looks like a hardware fault.

The discipline that prevents this is boring and effective: every entry point either completes the full sequence or returns the machine to its idle state. No partial state survives an error.

### The address that is almost right

A seven-bit address shifted left by one, or a write address used where a read address was intended, will sometimes produce a valid-looking ACK from a *different* device. The bus does not know which device you meant to talk to; it only knows who answered.

When a device behaves impossibly, dump the actual bytes on the wire before assuming the datasheet is wrong.

---

## Layer 4: Instruments and Method

### A scope tells you what a logic analyzer cannot

A logic analyzer answers "what did the protocol say" with great precision. It will not tell you that the rise time on SDA is 2.4 µs, that the signal only reaches 2.1 V, or that a glitch appears when the motor next to the board starts.

When a failure is intermittent, the ordering of investigation matters. Start with the analog view: verify that both lines reach valid logic levels, that rise times fit the clock period, and that the supply is clean during the transfer. Only once the electrical layer is confirmed should you move to decoding.

### Trigger on the failure, not on the traffic

Capturing ten thousand successful transfers to find the one that fails is not a strategy. Trigger on the error condition instead — an unexpected NACK, a bus-idle timeout, or the GPIO that your firmware toggles when it gives up. If the failure is rare enough that you cannot catch it in a session, log enough state to disk to reconstruct what happened, and revisit the log rather than the bus.

### Change one thing

The temptation, when a bus is failing, is to change several things at once and see if the problem goes away. This is how you end up with a system that works for reasons nobody understands and fails again the moment someone tidies the code.

Change one variable, verify, record. A small engineering notebook — paper is fine — documenting what was changed and what happened is worth more than any tool on this list.

---

## A Short Checklist

When a bus misbehaves, work outward from the silicon:

1. **Verify the electrical layer.** Do both lines reach valid high and low levels? Are the rise times within spec for your clock rate and bus capacitance?
2. **Check the pull-ups against the actual load.** Count the devices, measure the capacitance, compute the current each driver must sink.
3. **Confirm the protocol level.** Does the device require repeated start? Does the master honor clock stretching? Are the addresses correct, including the read/write bit?
4. **Inspect the driver.** Is there a recovery path after a failed transfer? Can the state machine become permanently stuck?
5. **Instrument the failure.** Trigger on the error, not on the traffic. Capture the analog and the digital view of the same event.
6. **Change one thing at a time.** Record what you changed and what happened.

---

## Closing Thought

I2C failures are rarely mysterious once you know which layer you are looking at. The bus itself is simple enough to fit on a napkin; the complexity lives in the assumptions we make about capacitance, timing, and how our own code behaves when something goes wrong.

The engineers who debug I2C well are not the ones with the most expensive equipment. They are the ones who resist the urge to change three things at once, and who treat "it works on my desk" as a hypothesis rather than a conclusion.
