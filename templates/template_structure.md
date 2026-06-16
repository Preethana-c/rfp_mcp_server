# QMAX PROPOSAL TEMPLATE STRUCTURE
# Use this EXACTLY — section names, heading levels, and table columns are fixed.
# Content fills in per RFP. Do NOT rename sections or change heading levels.

---
title: "Project title from RFP"
client: "Client company name"
nature: "Brief description of what is being built"
doc_number: "QMX-PRO-2026-XXX-001"
date: "Month DD, YYYY"
---

# Abbreviations & Acronyms

| Abbreviation | Expansion |
|---|---|
| AES | [expand] |
| [add all relevant abbreviations for this project] | [full form] |

# 1. Executive Summary

[~1 page. Open with the client's specific problem in their own words. State what Qmax proposes and why. Include a Commercial Summary table. Close with why Qmax wins.]

## Commercial Summary

| | Hours | Price (USD) |
|---|---|---|
| Hardware development @ $XX/hr | | $ |
| FPGA/firmware development @ $XX/hr | | $ |
| Prototype materials & assembly (budgetary, two spins) | — | $ (est.) |
| **Base program total** | | $ |
| Option A: [optional scope] | | $ |

# 2. Project Understanding & Requirements Compliance

[~1 page. Technical understanding of the project. Summarize what the adapter/device must do and key engineering decisions.]

## 2.1 Requirements Compliance Matrix

| Req. | Requirement (summary) | Compliance | Approach / Remarks |
|---|---|---|---|
| 1 | | Comply | |

# 3. Technical Approach & System Architecture

## 3.1 System Block Diagram

[Describe the system block diagram and main signal flow. Note where a diagram image would appear.]

## 3.2 Bandwidth Engineering

[Technical bandwidth analysis — data rates, format, link capacity, margins.]

## 3.3 Key Component Strategy

| Function | Candidate devices | Selection drivers |
|---|---|---|
| FPGA | | |
| Frame memory | | |

## 3.4 Mechanical & PCB Constraints

[Board dimensions, connector positions, height restrictions, referencing the customer O&M drawing.]

# 4. Complete Activity List (All Workstreams)

## 4.1 Program & Engineering Management

- [Bullet list of management activities]

## 4.2 Hardware Workstream

- [Bullet list of hardware activities]

## 4.3 FPGA / Firmware Workstream

- [Bullet list of FPGA/firmware activities]

## 4.4 Validation & Quality Workstream

- [Bullet list of validation activities]

# 5. Detailed FPGA Development Statement of Work

[Introduction: all RTL, firmware, constraints, build scripts developed by Qmax from scratch.]

## 5.1 Work Package FP-A: Architecture & Specification

- [Deliverables and activities]
- Exit criteria: [state gate requirement]

## 5.2 Work Package FP-B: MIPI CSI-2 Receiver

- [Activities]
- Exit criteria: [state]

## 5.3 Work Package FP-C: Video Pipeline & Buffering

- [Activities]
- Exit criteria: [state]

## 5.4 Work Package FP-D: 2.5 G Ethernet MAC & PCS

- [Activities]
- Exit criteria: [state]

## 5.5 Work Package FP-E: UDP/IP Hardware Offload

- [Activities]
- Exit criteria: [state]

## 5.6 Work Package FP-F: GVCP Control Engine

- [Activities]
- Exit criteria: [state]

## 5.7 Work Package FP-G: GVSP Streaming Engine

- [Activities]
- Exit criteria: [state]

## 5.8 Work Package FP-H: GenICam Compliance

- [Activities]
- Exit criteria: [state]

## 5.9 Work Package FP-I: Control-Plane Soft-Core & Firmware

- [Activities]
- Exit criteria: [state]

## 5.10 Work Package FP-J: Verification, Closure, Integration, Validation

- [Activities]
- Exit criteria: [state]

## 5.11 FPGA Deliverables

- [List of deliverable artifacts]

# 6. Detailed Effort Estimation

## 6.1 Hardware Development — $XX/hour

| ID | Activity & description | Hours | Cost |
|---|---|---|---|
| HW-01 | Requirements analysis, system architecture & ICD review | | |

Subtotal: | Hours | $ |

## 6.2 FPGA Development — $XX/hour

| ID | Activity & description | Hours | Cost |
|---|---|---|---|
| FP-01 | [activity] | | |

Subtotal: | Hours | $ |

## 6.3 Option A: [Optional scope] — $XX/hour

| ID | Activity & description | Hours | Cost |
|---|---|---|---|

Subtotal: | Hours | $ |

## 6.4 Program Cost Summary

| Line item | Hours | Rate | Cost (USD) |
|---|---|---|---|
| Hardware development | | $XX/hr | |
| FPGA development | | $XX/hr | |
| Prototype materials, fab & assembly — two spins (Qty 5 + Qty 20), budgetary, billed at cost | — | — | |
| **Base program total** | | | |
| Option A — [scope] | | $XX/hr | |
| **Total with Option A** | | | |

# 7. Tools, Equipment & Software

## 7.1 Design & Development Tools

| Tool | Purpose |
|---|---|
| [Tool name] | [Purpose] |

## 7.2 Test & Validation Equipment (Lab)

| Equipment | Use in this program |
|---|---|
| [Equipment] | [Use] |

# 8. Validation Plan

[Intro: validation executed in N phases. Each phase has documented procedures, pass/fail criteria and recorded results.]

## Phase V1 — Hardware Verification (per board)

| Test | Method | Pass criteria |
|---|---|---|

## Phase V2 — [Input] Validation

| Test | Method | Pass criteria |
|---|---|---|

## Phase V3 — [Protocol] Validation

| Test | Method | Pass criteria |
|---|---|---|

## Phase V4 — Performance & Robustness

| Test | Method | Pass criteria |
|---|---|---|

## Phase V5 — Production Screening (all N prototypes)

[Description of 100% functional screening procedure.]

# 9. Schedule (≈XX weeks, two PCB spins)

| Milestone | Week | Contents |
|---|---|---|
| Kickoff | W1 | |

[Add Gantt chart description or table]

# 10. Deliverables Summary

- [Bullet list of all contract deliverables]

# 11. Assumptions, Scope Definition & Dependencies

## 11.1 Technical Assumptions

A-1 — [Assumption text]

## 11.2 Customer Dependency Assumptions

A-XX — [Assumption text]

# 12. In-Scope and Out-of-Scope Activities

## 12.1 In Scope

- [Bullet list of in-scope items]

## 12.2 Out of Scope

- [Bullet list of out-of-scope items]

# 13. Risk Register

| ID | Risk | L | I | Mitigation / Contingency |
|---|---|---|---|---|
| R-01 | [Risk description] | M | H | [Mitigation] |

# 14. Terms & Conditions

## 14.1 Commercial

Validity: this proposal is valid for 60 days from the date of issue.

[Payment schedule, rates, material pass-through, taxes, currency.]

## 14.2 Scope & Change Management

[Requirements baseline, change order process, suspension/cancellation.]

## 14.3 Intellectual Property

[Deliverable IP assignment, background IP license, third-party content policy.]

## 14.4 Confidentiality & Export Control

[NDA reference, ITAR/export compliance, publicity restriction.]

## 14.5 Warranty & Liability

[Workmanship warranty, design warranty, liability cap.]

## 14.6 Delivery & Acceptance

[Delivery terms (Incoterms), acceptance criteria, schedule note.]

## 14.7 General

[Force majeure, independent contractor, governing law, order of precedence.]
