// Brand-specific operational message templates.
//
// LOCAL, EDITABLE DEFINITIONS ONLY — this module sends nothing, and is not
// wired into crm/routes/twilio.js, crm/routes/calcom.js, or any other route.
// It exists so template copy can be reviewed and approved before any
// automated sending is built or activated in a later checkpoint.
//
// Every template is `category: 'operational'` (appointment lifecycle /
// compliance only) — deliberately separate from any future marketing
// template set, which must live in its own module, never merged in here.
//
// Wording below is Loretta's approved exact copy (2026-08-12). Do not
// reword without her approval.
//
// Placeholders use {{attendee_name}}, {{appointment_type}}, {{date}},
// {{time}}, {{time_zone}}; each template's `placeholders` list reflects only
// the ones actually used in that template's body/text. No template names
// Medicare, makes a promotional claim, or references the other brand.

const TEMPLATES = {
  'insurance-lady': {
    appointmentConfirmationSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Insurance Lady LLC: Hi {{attendee_name}}, your {{appointment_type}} with Loretta Stewart is confirmed for {{date}} at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. Reply HELP for help or STOP to opt out.',
    },
    reminder24hSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['appointment_type', 'date', 'time', 'time_zone'],
      body: 'Insurance Lady LLC reminder: Your {{appointment_type}} with Loretta Stewart is tomorrow, {{date}}, at {{time}} {{time_zone}}. Loretta will call you. Reply HELP for help or STOP to opt out.',
    },
    reminder1hSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['appointment_type', 'time', 'time_zone'],
      body: 'Insurance Lady LLC reminder: Loretta Stewart will call you in about one hour for your {{appointment_type}} at {{time}} {{time_zone}}. Reply HELP for help or STOP to opt out.',
    },
    rescheduleNoticeSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Insurance Lady LLC: Hi {{attendee_name}}, your {{appointment_type}} with Loretta Stewart has been rescheduled to {{date}} at {{time}} {{time_zone}}. Loretta will call you then. Reply HELP for help or STOP to opt out.',
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
      body: 'Prosperity Life & Financial Solutions: Hi {{attendee_name}}, your {{appointment_type}} with Loretta Stewart is confirmed for {{date}} at {{time}} {{time_zone}}. Loretta will call you at the scheduled time. Reply HELP for help or STOP to opt out.',
    },
    reminder24hSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['appointment_type', 'date', 'time', 'time_zone'],
      body: 'Prosperity reminder: Your {{appointment_type}} with Loretta Stewart is tomorrow, {{date}}, at {{time}} {{time_zone}}. Loretta will call you. Reply HELP for help or STOP to opt out.',
    },
    reminder1hSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['appointment_type', 'time', 'time_zone'],
      body: 'Prosperity reminder: Loretta Stewart will call you in about one hour for your {{appointment_type}} at {{time}} {{time_zone}}. Reply HELP for help or STOP to opt out.',
    },
    rescheduleNoticeSms: {
      category: 'operational', channel: 'sms',
      placeholders: ['attendee_name', 'appointment_type', 'date', 'time', 'time_zone'],
      body: 'Prosperity Life & Financial Solutions: Hi {{attendee_name}}, your {{appointment_type}} with Loretta Stewart has been rescheduled to {{date}} at {{time}} {{time_zone}}. Loretta will call you then. Reply HELP for help or STOP to opt out.',
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
  'appointmentConfirmationSms', 'reminder24hSms', 'reminder1hSms',
  'rescheduleNoticeSms', 'cancellationNoticeSms', 'missedCallTextBack',
  'helpResponseSms', 'appointmentConfirmationEmail',
];

function getTemplate(brandId, templateKey) {
  const brandTemplates = TEMPLATES[brandId];
  return brandTemplates ? (brandTemplates[templateKey] || null) : null;
}

module.exports = { TEMPLATES, REQUIRED_TEMPLATE_KEYS, getTemplate };
