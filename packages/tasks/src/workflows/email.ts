import { task } from '@trigger.dev/sdk';

export interface SendEmailTaskPayload {
  to: string;
  subject: string;
  html: string;
}

interface SendEmailTaskWrappedPayload {
  payload: SendEmailTaskPayload;
}

type SendEmailTaskInput = SendEmailTaskPayload | SendEmailTaskWrappedPayload;

const extractPayload = (input: SendEmailTaskInput): SendEmailTaskPayload => {
  return 'payload' in input ? input.payload : input;
};

export const sendEmailTask = task({
  id: 'send_email',
  run: async (input: SendEmailTaskInput) => {
    if (typeof window !== 'undefined') {
      throw new Error('sendEmailTask must run on the server');
    }

    const nodemailer = await import('nodemailer');
    const payload = extractPayload(input);

    const transporter = nodemailer.createTransport({
      host: 'mail.privateemail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    const { to, subject, html } = payload;

    return transporter.sendMail({
      from: process.env.EMAIL,
      to,
      subject,
      html,
    });
  },
});
