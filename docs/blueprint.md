# CourseConnect — Bot specification

**Archetype:** commerce

**Voice:** professional and warm — write every user-facing message, button label, error, and empty state in this voice.

A marketplace bot connecting teachers with students for paid online courses. Teachers create scheduled courses with fixed timetables, set prices, and manage capacity. Students browse courses, pay one-time fees, receive session join links, and get automated reminders via Telegram. Payments and refunds flow through a marketplace system with automatic teacher payouts.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Teachers offering online courses
- Students seeking course enrollments

## Success criteria

- Teachers can create and manage courses with session schedules
- Students receive join links and reminders via Telegram
- Automatic payment processing and refunds for cancellations
- Waiting list auto-promotion when spots open

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with teacher/student options
- **Create Course** (button, actor: teacher, callback: teacher:create_course) — Launch course creation wizard with session scheduling
- **Browse Courses** (button, actor: student, callback: student:browse_courses) — View available courses with session details
- **My Enrollments** (button, actor: student, callback: student:my_enrollments) — View active courses and session schedule
- **Manage Sessions** (button, actor: teacher, callback: teacher:manage_sessions) — Edit session capacity/waiting list

## Flows

### Teacher Onboarding
_Trigger:_ /start

1. Select teacher/student role
2. Create teacher profile
3. Create first course
4. Set course price and session schedule

_Data touched:_ Teacher, Course

### Student Enrollment
_Trigger:_ student:browse_courses

1. Browse course catalog
2. Select course/session
3. Process one-time payment
4. Receive enrollment confirmation

_Data touched:_ Enrollment, Payment

### Waiting List Promotion
_Trigger:_ session:spot_available

1. Check waiting list
2. Auto-enroll next student
3. Send promotion notification

_Data touched:_ WaitingList, Enrollment

### Cancellation Handling
_Trigger:_ session:cancellation

1. Process refund
2. Update waiting list
3. Send cancellation notice

_Data touched:_ Payment, WaitingList

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Teacher** _(retention: persistent)_ — Teacher profile with course management rights
  - fields: id, name, bio, timezone
- **Course** _(retention: persistent)_ — Course with pricing and session schedule
  - fields: id, title, price, session_ids
- **Session** _(retention: persistent)_ — Scheduled class instance with capacity tracking
  - fields: id, start_time, capacity, waiting_list, join_url
- **Student** _(retention: persistent)_ — Student profile with enrollment history
  - fields: id, name, enrollment_ids
- **Enrollment** _(retention: persistent)_ — Student course/session enrollment record
  - fields: student_id, course_id, session_ids, payment_status
- **Payment** _(retention: persistent)_ — Transaction record with refund status
  - fields: id, amount, student_id, course_id, refund_status
- **WaitingList** _(retention: persistent)_ — Queue for session capacity overflow
  - fields: session_id, student_ids

## Integrations

- **Telegram** (required) — Bot API messaging and notifications
- **PaymentProvider** (required) — Marketplace payment processing
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Teacher dashboard for session management
- Student enrollment history view
- Payment status tracking interface
- Waiting list configuration settings

## Notifications

- Session reminders (24h and 30m before start)
- Enrollment confirmation with join link
- Waiting list promotion notifications
- Payment success/refund status updates

## Permissions & privacy

- Secure payment token handling
- Private session join link delivery
- User data encryption at rest
- Waiting list student data protection

## Edge cases

- Session timezone conversion errors
- Concurrent waiting list promotions
- Payment gateway failures during enrollment
- Teacher session cancellation after payment

## Required tests

- End-to-end course creation to student enrollment flow
- Waiting list auto-promotion with notifications
- Payment processing with refund scenarios
- Timezone-aware session scheduling

## Assumptions

- Payment provider handles currency conversion
- All session times include timezone conversion
- Waiting list follows first-come-first-served order
- Teacher receives payout after session completion
