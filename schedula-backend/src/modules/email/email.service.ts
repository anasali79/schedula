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
      subject: "Welcome to Schedula – Let’s Get You Verified!",

      html: `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.7; color: #1f2937; max-width: 600px; margin: auto; padding: 20px;">
    
    <h1 style="color: #212525ff; margin-bottom: 10px;">
      Welcome to Schedula 👋
    </h1>

    <p style="font-size: 16px;">
      We're excited to have you onboard! 🎉  
      Your smarter scheduling journey officially starts here.
    </p>

    <p style="font-size: 16px;">
      But before we roll out the red carpet… we just need to confirm one thing:
    </p>

    <h2 style="color: #16a34a; margin-top: 20px;">
      Verify Your Email Address
    </h2>

    <p style="font-size: 15px;">
      Click the button below to activate your account.  
      It takes 2 seconds. (Yes, we timed it 😄)
    </p>

    <div style="text-align: center; margin: 25px 0;">
      <a href="${verificationLink}" 
         style="display:inline-block; padding:14px 26px; background: linear-gradient(90deg, #2563eb, #1d4ed8); color:#ffffff; text-decoration:none; border-radius:10px; font-weight:600; font-size:16px;">
         Verify My Email
      </a>
    </div>

    <p style="font-size: 14px; color: #4b5563;">
      Prefer the old-school way? Copy & paste this link into your browser:
    </p>

    <p style="word-break: break-all; font-size: 14px; color:#2563eb;">
      ${verificationLink}
    </p>

    <p style="font-size: 14px; margin-top: 20px;">
      This verification link will expire in 24 hours — because security matters.
    </p>

    <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />

    <p style="font-size: 13px; color: #6b7280;">
      If you didn’t create an account with Schedula, no worries.  
      You can safely ignore this email.
    </p>

    <p style="margin-top: 25px; font-size: 15px;">
      See you inside, <br/>
      <strong>Team Schedula </strong>
    </p>

  </div>
`,
    });
  }
}
