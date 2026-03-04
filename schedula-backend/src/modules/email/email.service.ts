import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    const host = process.env.EMAIL_HOST;
    const port = parseInt(process.env.EMAIL_PORT || '587', 10);
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
    }
  }

  async sendWelcomeVerificationEmail(to: string, verificationLink: string): Promise<void> {
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@schedula.com';

    if (!this.transporter) {
      console.warn('[Email] SMTP not configured. Would send verification to:', to, 'Link:', verificationLink);
      return;
    }

    await this.transporter.sendMail({
      from,
      to,
      subject: 'Welcome to Schedula – Verify your email',
      html: `
        <h1>Welcome to Schedula!</h1>
        <p>Thank you for signing up. Please verify your email address by clicking the link below:</p>
        <p><a href="${verificationLink}" style="color: #2563eb;">Verify my email</a></p>
        <p>Or copy and paste this URL in your browser:</p>
        <p>${verificationLink}</p>
        <p>This link will expire in 24 hours.</p>
        <p>If you did not create an account, you can safely ignore this email.</p>
      `,
    });
  }
}
