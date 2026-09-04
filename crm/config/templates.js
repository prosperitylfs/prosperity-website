// Brand-specific operational message templates.
//
// LOCAL, EDITABLE DEFINITIONS ONLY — this module itself sends nothing (pure
// data), but appointmentConfirmationSms, rescheduleNoticeSms, reminder24hSms,
// reminder1hSms, and reminder15mSms ARE wired into crm/routes/calcom.js /
// crm/lib/appointmentReminderScheduler.js via
// crm/lib/appointmentConfirmationSms.js (new booking + reschedule
// confirmations + the three reminder SMS). The other templates here remain
// unwired scaffolding for a later checkpoint.
//
// Every template is `category: 'operational'` (appointment lifecycle /
// compliance only) — deliberately separate from any future marketing
// template set, which must live in its own module, never merged in here.
//
// Wording below is Loretta's approved exact copy (revised 2026-08-30 for
// appointmentConfirmationSms/rescheduleNoticeSms; 2026-08-31 for
// reminder24hSms/reminder1hSms/reminder15mSms — first name only, natural
// closing brand identification instead of a leading prefix; and again
// 2026-08-31 for the three reminder templates so each one explicitly names
// which reminder it is ("this is your 24-hour reminder" / "1-hour reminder"
// / "15-minute reminder") while still stating the actual appointment time —
// every other template is still the original 2026-08-12 copy). Do not
// reword without her approval.
//
// Placeholders use {{attendee_name}}, {{appointment_type}}, {{date}},
// {{time}}, {{time_zone}}, {{day_phrase}}; each template's `placeholders`
// list reflects only the ones actually used in that template's body/text.
// No template names Medicare, makes a promotional claim, or references the
// other brand.
//
// {{attendee_name}} is filled with the FIRST NAME ONLY by the sender
// (crm/lib/appointmentConfirmationSms.js) -- the placeholder name is kept
// as-is (not renamed to first_name) to avoid unnecessary churn, but every
// appointmentConfirmationSms/rescheduleNoticeSms body below is written
// assuming a first name in that slot ("Hi Janet," not "Hi Janet Jackson,").
//
// appointmentConfirmationSms/rescheduleNoticeSms bodies identify the
// company near the END of the message ("- Insurance Lady LLC." /
// "- Prosperity Life & Financial Solutions."), not as a leading prefix, per
// Loretta's revised approved copy (2026-08-30). A plain hyphen is used
// rather than an em dash so the message stays within the GSM-7 character
// set (see the GSM-7 test in crm/test/templates.test.js) -- an em dash
// would force UCS-2 encoding and roughly halve the per-segment character
// budget.

const TEMPLATES = {
  'insurance-lady': {
    appointmentConfirmationSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, your {{appointment_type}} with Loretta Stewart is confirmed for {{date}} at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
    },
    reminder24hSms: {
      category: 'operational', channel: 'sms',
      // {{day_phrase}} is computed by the sender (crm/lib/appointmentConfirmationSms.js):
      // "tomorrow" normally, or "on <full date>" when that would be inaccurate
      // (a calendar-day edge case) -- see that file's computeDayPhrase().
      placeholders: ['attendee_name', 'appointment_type', 'day_phrase', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, this is your 24-hour reminder. Your {{appointment_type}} with Loretta Stewart is {{day_phrase}} at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. Need to reschedule? Reply RESCHEDULE. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
    },
    reminder1hSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, this is your 1-hour reminder. Your {{appointment_type}} with Loretta Stewart begins at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
    },
    reminder15mSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, this is your 15-minute reminder. Your {{appointment_type}} with Loretta Stewart begins at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
    },
    rescheduleNoticeSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, your {{appointment_type}} with Loretta Stewart has been rescheduled for {{date}} at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
    },
    cancellationNoticeSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Insurance Lady LLC: Hi {{attendee_name}}, your {{appointment_type}} scheduled for {{date}} at {{time}} {{time_zone}} has been canceled. Call 855-930-5239 if you would like to reschedule. Reply HELP for help or STOP to opt out.',
    },
    missedCallTextBack: {
      category: 'operational', channel: 'sms',
      placeholders: [],
      body: 'Insurance Lady LLC: Sorry we missed your call. Reply with your name and how we can help, or call 855-930-5239. Reply STOP to opt out.',
    },
    helpResponseSms: {
      category: 'operational', channel: 'sms',
      placeholders: [],
      body: 'Insurance Lady LLC: For assistance, call 855-930-5239 or visit https://insuranceladyllc.com. Message and data rates may apply. Reply STOP to opt out.',
    },
    appointmentConfirmationEmail: {
      category: 'operational', channel: 'email',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      subject: 'Your appointment with Insurance Lady LLC is confirmed',
      text:
`Hi {{attendee_name}},

Your {{appointment_type}} with Loretta Stewart is confirmed for {{date}} at {{time}} {{time_zone}}.

Loretta will call you at the scheduled time using the telephone number provided with your booking.

If you need to make a change, call 855-930-5239 or visit https://insuranceladyllc.com.

Thank you,

Loretta Stewart
Insurance Lady LLC`,
    },
  },

  prosperity: {
    appointmentConfirmationSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, your {{appointment_type}} with Loretta Stewart is confirmed for {{date}} at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
    },
    reminder24hSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'day_phrase', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, this is your 24-hour reminder. Your {{appointment_type}} with Loretta Stewart is {{day_phrase}} at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. Need to reschedule? Reply RESCHEDULE. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
    },
    reminder1hSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, this is your 1-hour reminder. Your {{appointment_type}} with Loretta Stewart begins at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
    },
    reminder15mSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, this is your 15-minute reminder. Your {{appointment_type}} with Loretta Stewart begins at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
    },
    rescheduleNoticeSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Hi {{attendee_name}}, your {{appointment_type}} with Loretta Stewart has been rescheduled for {{date}} at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
    },
    cancellationNoticeSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Prosperity Life & Financial Solutions: Hi {{attendee_name}}, your {{appointment_type}} scheduled for {{date}} at {{time}} {{time_zone}} has been canceled. Call 414-441-1177 if you would like to reschedule. Reply HELP for help or STOP to opt out.',
    },
    missedCallTextBack: {
      category: 'operational', channel: 'sms',
      placeholders: [],
      body: 'Prosperity: Sorry we missed your call. Reply with your name and how we can help, or call 414-441-1177. Reply STOP to opt out.',
    },
    helpResponseSms: {
      category: 'operational', channel: 'sms',
      placeholders: [],
      body: 'Prosperity Life & Financial Solutions: For assistance, call 414-441-1177 or visit https://www.prosperitylfs.com. Message and data rates may apply. Reply STOP to opt out.',
    },
    appointmentConfirmationEmail: {
      category: 'operational', channel: 'email',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      subject: 'Your appointment with Prosperity is confirmed',
      text:
`Hi {{attendee_name}},

Your {{appointment_type}} with Loretta Stewart is confirmed for {{date}} at {{time}} {{time_zone}}.

Loretta will call you at the scheduled time using the telephone number provided with your booking.

If you need to make a change, call 414-441-1177 or visit https://www.prosperitylfs.com.

Warm regards,

Loretta Stewart
Prosperity Life & Financial Solutions LLC`,
    },

    // ── Existing Client Reconnection outreach (Revenue MVP, 2026-09) ────────
    // Prosperity-only, deliberately not added to REQUIRED_TEMPLATE_KEYS below
    // (so this never needs an Insurance Lady counterpart) and never used by
    // any generic send path — only crm/lib/existingClientOutreach.js's
    // dedicated, narrowly-scoped sender calls these two keys. Loretta's
    // approved exact copy, with one technical adjustment: the em dash before
    // the signature was changed to a plain hyphen (matches every other SMS
    // template in this file, see the GSM-7 comment above). Footer is
    // "Reply STOP to opt out." only (2026-09-06 revision) -- the HELP
    // language was removed from the visible footer on both Existing Client
    // Outreach SMS templates; inbound HELP keyword handling
    // (crm/lib/inboundSmsService.js) is untouched and still works the same
    // regardless of what the outbound message's footer says.
    existingClientReconnectionSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['first_name'],
      body: `Hi {{first_name}}, this is Loretta Stewart, your insurance agent with Prosperity Life & Financial Solutions.

I'm reaching out to reconnect and make sure your life insurance policy and contact information are up to date.

This is my current office/text number, so please save it for future policy service.

May I text you at this number regarding your policy, appointments, policy reviews and service needs?

Reply YES to allow text communication.

- Loretta Stewart
Prosperity Life & Financial Solutions

Reply STOP to opt out.`,
    },
    // Loretta's exact approved copy (verbatim) -- the only technical
    // adjustment made is replacing the curly apostrophes the source text
    // was pasted with (’) with plain straight ones ('), matching every
    // other template in this file: a curly apostrophe forces UCS-2 SMS
    // encoding (same reasoning as the em-dash comment above), which would
    // roughly halve this already-long message's per-segment character
    // budget. The wording itself is unchanged. Footer is "Reply STOP to
    // opt out." only (2026-09-05 revision) -- deliberately NOT the
    // Reply HELP/STOP footer used on existingClientReconnectionSms above;
    // STOP keyword handling (crm/lib/inboundSmsService.js) works the same
    // regardless of which opt-out wording the outbound message shows.
    existingClientLifeInsuranceAwarenessSms: {
      category: 'operational', channel: 'sms',
      // {{booking_link}} deliberately removed (2026-09-04 revision) -- this
      // initial message no longer offers a self-service booking link at
      // all; Loretta follows up by phone instead, and only sends the
      // booking link separately if the client asks for it in their reply.
      placeholders: ['first_name'],
      body: `Hi {{first_name}}, this is Loretta Stewart, your insurance agent. I'm reaching out to reconnect and make sure you have my current office contact information. This is my new office and texting number, so please save it so you'll recognize me when I call and have it whenever you need assistance with your policy.

Since September is Life Insurance Awareness Month, it's also a good time to make sure the information on your policy is still current. Life changes over the years, and things such as your contact information, beneficiaries, or coverage needs may have changed since we last spoke.

I'll be reaching out by phone over the next few days to reconnect and discuss your policy with you.

I'd also like your permission to communicate with you by text regarding your policy, appointments, and service needs. Reply YES if I may text you, or NO if you prefer not to receive text messages. If you'd like my booking link, just let me know and I'll send it to you.

Loretta Stewart
Prosperity Life & Financial Solutions

Reply STOP to opt out.`,
    },
    existingClientReconnectionEmail: {
      category: 'operational', channel: 'email',
      placeholders: ['first_name', 'office_phone'],
      subject: "It's Time for Your Life Insurance Policy Review",
      text:
`Hi {{first_name}},

This is Loretta Stewart with Prosperity Life & Financial Solutions.

I'm reaching out to reconnect and make sure your life insurance policy and contact information are still up to date.

Life changes over the years, so it's important to periodically review things such as your beneficiaries, contact information, coverage and other policy details.

September is Life Insurance Awareness Month, so I'm reaching out to my existing clients and encouraging everyone to take a few minutes to review their current coverage.

I also have a new office/text number. Please save:

{{office_phone}}

If you'd like me to communicate with you by text regarding your policy, appointments, policy reviews and service needs, simply reply YES to the text message I send you from that number.

I look forward to reconnecting with you.

Loretta Stewart
Life & Retirement Advisor
Prosperity Life & Financial Solutions
{{office_phone}}`,
    },

    // Loretta's exact approved copy (verbatim, including the subject's em
    // dash -- unlike the SMS templates above, email has no GSM-7/segment
    // cost concern, so no character substitution was needed here).
    existingClientSmsPermissionEmail: {
      category: 'operational', channel: 'email',
      placeholders: ['first_name', 'office_phone', 'booking_link'],
      subject: 'A Quick Update From Loretta — Please Save My New Office Number',
      text:
`Hi {{first_name}},

This is Loretta Stewart, your insurance agent. I'm reaching out to reconnect and make sure you have my current contact information.

My current Prosperity Life & Financial Solutions office and texting number is {{office_phone}}. Please save this number so you'll recognize me when I call and have it whenever you need assistance with your policy.

I'd also like your permission to communicate with you by text regarding your policy, appointments, and service needs.

If you would like to receive service-related text messages from me, simply reply to this email with:

YES, you may text me at [your mobile number].

If you prefer not to receive text messages, you may reply:

NO TEXTS.

If you would like to schedule a time to speak with me, you can do that here:

{{booking_link}}

I look forward to reconnecting with you.

Loretta Stewart
Prosperity Life & Financial Solutions
{{office_phone}}`,
    },
  },
};

const REQUIRED_TEMPLATE_KEYS = [
  'appointmentConfirmationSms', 'reminder24hSms', 'reminder1hSms', 'reminder15mSms',
  'rescheduleNoticeSms', 'cancellationNoticeSms', 'missedCallTextBack',
  'helpResponseSms', 'appointmentConfirmationEmail',
];

function getTemplate(brandId, templateKey) {
  const brandTemplates = TEMPLATES[brandId];
  return brandTemplates ? (brandTemplates[templateKey] || null) : null;
}

module.exports = { TEMPLATES, REQUIRED_TEMPLATE_KEYS, getTemplate };
