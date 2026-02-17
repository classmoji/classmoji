import { task } from '@trigger.dev/sdk';

export const sendEmailTask = task({
  id: 'send_email',
  run: async arg => {
    let nodemailer;
    if (typeof window === 'undefined') {
      nodemailer = (await import('nodemailer')).default; // Explicitly access the default export
    }

    const payload = arg?.payload ? arg.payload : arg;

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

    const mailOptions = {
      from: process.env.EMAIL,
      to,
      subject,
      html,
    };

    return transporter.sendMail(mailOptions);
  },
});
