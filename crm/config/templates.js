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
