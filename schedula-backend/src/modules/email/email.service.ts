import { Injectable } from '@nestjs/common';

@Injectable()
export class EmailService {
  private readonly resendApiKey = process.env.RESEND_API_KEY;
  // Note: Resend free tier without custom domain only allows sending to your own email 
  // or using their default 'onboarding@resend.dev' sender address.
  private readonly fromEmail = 'onboarding@resend.dev'; 

  constructor() {
    if (!this.resendApiKey) {
      console.warn('[EmailService] RESEND_API_KEY is missing. Emails will not be sent.');
    } else {
      console.log('[EmailService] Initialized with Resend API');
    }
  }

  private async sendViaResend(to: string, subject: string, html: string) {
    if (!this.resendApiKey) return;

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.resendApiKey}`,
        },
        body: JSON.stringify({
          from: `Schedula <${this.fromEmail}>`,
          to: [to],
          subject: subject,
          html: html,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Resend API error');
      }
      console.log(`[EmailService] Email sent successfully via Resend to ${to}`);
      return data;
    } catch (error: any) {
      console.error(`[EmailService] Failed to send email to ${to}:`, error.message);
    }
  }

  async sendWelcomeVerificationEmail(to: string, verificationLink: string): Promise<void> {
    const html = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.7; color: #1f2937; max-width: 600px; margin: auto; padding: 20px;">
        <h1 style="color: #212525ff; margin-bottom: 10px;">Welcome to Schedula 👋</h1>
        <p>Verify your email address by clicking the button below:</p>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${verificationLink}" style="display:inline-block; padding:14px 26px; background: #2563eb; color:#ffffff; text-decoration:none; border-radius:10px; font-weight:600;">Verify My Email</a>
        </div>
        <p>Or copy this link: ${verificationLink}</p>
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />
        <p>Team Schedula</p>
      </div>
    `;
    await this.sendViaResend(to, "Welcome to Schedula – Verify Your Email", html);
  }

  async sendAppointmentConfirmation(data: any): Promise<void> {
    const { patientName, doctorName, date, day, slotTime, token, reportingTime } = data;
    const html = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Appointment Confirmed! ✅</h2>
        <p>Hello ${patientName}, your appointment with Dr. ${doctorName} is confirmed.</p>
        <p><b>Date:</b> ${day}, ${date}<br><b>Time:</b> ${slotTime}<br><b>Token:</b> #${token}</p>
        <p>Reporting time: ${reportingTime}</p>
      </div>
    `;
    await this.sendViaResend(data.to, '✅ Appointment Confirmed - Schedula', html);
  }

  async sendGoogleWelcomeEmail(to: string): Promise<void> {
    const html = `<h1>Welcome to Schedula! 🎉</h1><p>Your Google signup was successful.</p>`;
    await this.sendViaResend(to, "Welcome to Schedula! 🚀", html);
  }

  async sendAppointmentCancellation(data: any): Promise<void> {
    const html = `<h2>Appointment Cancelled ❌</h2><p>Your appointment on ${data.date} at ${data.slotTime} has been cancelled.</p>`;
    await this.sendViaResend(data.to, '❌ Appointment Cancelled - Schedula', html);
  }

  async sendAppointmentReschedule(data: any): Promise<void> {
    const html = `<h2>Appointment Rescheduled 🔄</h2><p>New time: ${data.newDate} at ${data.newSlotTime}</p>`;
    await this.sendViaResend(data.to, '🔄 Appointment Rescheduled - Schedula', html);
  }
}
