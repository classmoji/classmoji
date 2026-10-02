/**
 * Meeting invitations as people paste them into the meeting-link field.
 *
 * SYNTHETIC: the people, schools, meeting ids, passcodes, tokens and tenant ids
 * are made up; phone numbers are fictional 555-01xx numbers and the one IP
 * address is from a documentation range. The service domains (zoom.us,
 * zoomcrc.com, aka.ms, teams.microsoft.com, meet.google.com, tel.meet,
 * webex.com) are the services' own. The layout follows each service's
 * invitation text — which links appear, in what order, wrapped how — because
 * that is what the link picker has to get right: the join link is often not
 * the first link.
 */

/** Zoom, recurring meeting: the calendar-file link comes before the join link. */
export const ZOOM_JOIN = 'https://school.zoom.us/j/91234567890?pwd=AbCdEfGhIjKlMnOpQrStUv.1';
export const ZOOM_INVITATION = `Alex Rivera is inviting you to a scheduled Zoom meeting.

Topic: Office Hours
Time: Oct 6, 2026 02:00 PM Eastern Time (US and Canada)
        Every week on Tue, until Nov 17, 2026, 7 occurrence(s)
Please download and import the following iCalendar (.ics) files to your calendar system.
Weekly: https://school.zoom.us/meeting/tExampleMeeting0001/ics?icsToken=example-token-0001

Join Zoom Meeting
${ZOOM_JOIN}

Meeting ID: 912 3456 7890
Passcode: 123456

---

One tap mobile
+15550100101,,91234567890#,,,,*123456# US
+15550100102,,91234567890#,,,,*123456# US

---

Dial by your location
• +1 555 010 0101 US
• +1 555 010 0102 US

Find your local number: https://school.zoom.us/u/abCdEfGhIj

---

Join by SIP
• 91234567890@zoomcrc.com`;

/** Teams, older layout: "Need help?" comes first, every link in angle brackets. */
export const TEAMS_OLD_JOIN =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmE0NTQ4YjQtMDAwMC00MDAwLWEwMDAtMDAwMDAwMDAwMDAw%40thread.v2/0?context=%7b%22Tid%22%3a%2200000000-0000-4000-8000-000000000000%22%2c%22Oid%22%3a%2200000000-0000-4000-8000-000000000001%22%7d';
export const TEAMS_OLD_INVITATION = `________________________________________________________________________________
Microsoft Teams Need help? <https://aka.ms/JoinTeamsMeeting?omkt=en-US>
Join the meeting now <${TEAMS_OLD_JOIN}>
Meeting ID: 212 345 678 901
Passcode: Ab3cD4
________________________________
Dial in by phone
+1 603-555-0142,,123456789# <tel:+16035550142,,123456789#> United States, Manchester
Find a local number <https://dialin.teams.microsoft.com/0000aaaa-bbbb-cccc-dddd-eeeeffff0000?id=123456789>
Phone conference ID: 123 456 789#
For organizers: Meeting options <https://teams.microsoft.com/meetingOptions/?organizerId=00000000-0000-4000-8000-000000000001&tenantId=00000000-0000-4000-8000-000000000000&language=en-US> | Reset dial-in PIN <https://dialin.teams.microsoft.com/usp/pstnconferencing>
________________________________________________________________________________`;

/** Teams, newer layout: the short /meet/ link, printed in full. */
export const TEAMS_NEW_JOIN = 'https://teams.microsoft.com/meet/21234567890123?p=AbCdEfGhIjKlMnOp';
export const TEAMS_NEW_INVITATION = `________________________________________________________________________________
Microsoft Teams Need help?<https://aka.ms/JoinTeamsMeeting?omkt=en-US>
Join: ${TEAMS_NEW_JOIN}
Meeting ID: 212 345 678 901 23
Passcode: Ab3cD4
________________________________
For organizers: Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=00000000-0000-4000-8000-000000000001&tenantId=00000000-0000-4000-8000-000000000000&language=en-US>
________________________________________________________________________________`;

/**
 * Google Meet, copied from a calendar event: the join link is printed without
 * its scheme, the phone page with one, and the phone numbers sit between
 * invisible direction marks.
 */
export const MEET_JOIN = 'https://meet.google.com/abc-defg-hij';
export const MEET_BARE_HOST_INVITATION = `Lab check-in
Tuesday, October 6 · 2:00 – 3:00pm
Time zone: America/New_York
Google Meet joining info
Video call link: meet.google.com/abc-defg-hij
Or dial: \u202A(US) +1 603-555-0175\u202C PIN: \u202A123 456 789\u202C#
More phone numbers: https://tel.meet/abc-defg-hij?pin=1234567890123`;

/** Webex: join link first, help page last, a video-system address in between. */
export const WEBEX_JOIN =
  'https://school.webex.com/school/j.php?MTID=m0123456789abcdef0123456789abcdef';
export const WEBEX_INVITATION = `Alex Rivera invites you to join this Webex meeting.

Join meeting
${WEBEX_JOIN}

Tuesday, October 6, 2026 2:00 PM | 1 hour | (UTC-04:00) Eastern Time (US & Canada)
Meeting number: 2630 123 4567
Password: AbCd1234

Join by video system
Dial 26301234567@school.webex.com
You can also dial 192.0.2.68 and enter your meeting number.

Join by phone
+1-555-010-0199 US Toll
Access code: 2630 123 4567

Need help? Go to https://help.webex.com`;

/** Teams, launcher page: the join link wrapped in a deep-link page. */
export const TEAMS_LAUNCHER_JOIN =
  'https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_ZmE0NTQ4YjQtMDAwMC00MDAwLWEwMDAtMDAwMDAwMDAwMDAw%40thread.v2%2F0%3Fcontext%3D%257b%2522Tid%2522%253a%252200000000-0000-4000-8000-000000000000%2522%252c%2522Oid%2522%253a%252200000000-0000-4000-8000-000000000001%2522%257d%26anon%3Dtrue&type=meetup-join&deeplinkId=00000000-0000-4000-8000-000000000002&directDl=true&msLaunch=true&enableMobilePage=true&suppressPrompt=true';

/** A Teams join link as an Outlook link-scanning service rewrites it. */
export const SAFELINKS_TEAMS_JOIN =
  'https://nam12.safelinks.protection.outlook.com/?url=' +
  encodeURIComponent(TEAMS_OLD_JOIN) +
  '&data=05%7C02%7Cta%40school.example%7C00000000000000000000000000000000%7C00000000000000000000000000000000%7C0%7C0%7C638600000000000000%7CUnknown%7CTWFpbGZsb3d8eyJWIjoiMC4wLjAwMDAiLCJQIjoiV2luMzIiLCJBTiI6Ik1haWwiLCJXVCI6Mn0%3D%7C0%7C%7C%7C&sdata=ExampleSignature000000000000000000000000000%3D&reserved=0';
