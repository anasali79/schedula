import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as dns from 'node:dns';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    const host = process.env.EMAIL_HOST?.trim();
    const port = parseInt(process.env.EMAIL_PORT?.trim() || '587', 10);
    const user = process.env.EMAIL_USER?.trim();
    const pass = process.env.EMAIL_PASS?.trim();

    if (user && pass) {
      console.log(`[EmailService] SMTP Initializing (Port 465 + Pooling) for ${user}`);
      this.transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass },
        connectionTimeout: 10000,
        // Force DNS to only return IPv4 addresses
        lookup: (hostname: string, options: any, callback: any) => {
          dns.lookup(hostname, { family: 4 }, callback);
        },
      } as any);
    } else {
      console.warn('[EmailService] SMTP credentials missing in environment variables. Emails will not be sent.');
    }
  }

  async sendWelcomeVerificationEmail(to: string, verificationLink: string): Promise<void> {
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@schedula.com';

    if (!this.transporter) {
      console.warn('[Email] SMTP not configured. Verification Link:', verificationLink);
      return;
    }

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: "Welcome to Schedula – Let’s Get You Verified!",
        html: `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.7; color: #1f2937; max-width: 600px; margin: auto; padding: 20px;">
      <h1 style="color: #212525ff; margin-bottom: 10px;">Welcome to Schedula 👋</h1>
      <p style="font-size: 16px;">We're excited to have you onboard! 🎉 Your smarter scheduling journey officially starts here.</p>
      <p style="font-size: 16px;">But before we roll out the red carpet… we just need to confirm one thing:</p>
      <h2 style="color: #16a34a; margin-top: 20px;">Verify Your Email Address</h2>
      <p style="font-size: 15px;">Click the button below to activate your account. It takes 2 seconds.</p>
      <div style="text-align: center; margin: 25px 0;">
        <a href="${verificationLink}" style="display:inline-block; padding:14px 26px; background: linear-gradient(90deg, #2563eb, #1d4ed8); color:#ffffff; text-decoration:none; border-radius:10px; font-weight:600; font-size:16px;">Verify My Email</a>
      </div>
      <p style="word-break: break-all; font-size: 14px; color:#2563eb;">${verificationLink}</p>
      <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />
      <p style="margin-top: 25px; font-size: 15px;">See you inside, <br/><strong>Team Schedula </strong></p>
    </div>
  `,
      });
      console.log(`[Email] Verification email sent to: ${to}`);
    } catch (error: any) {
      console.error(`[Email] SMTP Error for ${to}:`, error.message);
    }
  }

  async sendMail(options: { to: string; subject: string; text?: string; html?: string }): Promise<void> {
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@schedula.com';

    if (!this.transporter) {
      console.warn('[Email] SMTP not configured. Would send email to:', options.to, 'Subject:', options.subject);
      return;
    }

    await this.transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
  }

  async sendAppointmentConfirmation(data: {
    to: string;
    patientName: string;
    doctorName: string;
    date: string;
    day: string;
    slotTime: string;
    token: number;
    reportingTime: string;
    appointmentId: string;
    notes?: string;
  }): Promise<void> {
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@schedula.com';

    if (!this.transporter) {
      console.warn('[Email] SMTP not configured. Appointment confirmation for:', data.to);
      return;
    }

    const { patientName, doctorName, date, day, slotTime, token, reportingTime, appointmentId, notes } = data;

    await this.transporter.sendMail({
      from,
      to: data.to,
      subject: '✅ Appointment Confirmed - Schedula',
      html: `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
          <h2 style="color: #16a34a; margin-top: 0;">Appointment Confirmed! ✅</h2>
          <p>Hello <strong>${patientName}</strong>,</p>
          <p>Your appointment with <strong>${doctorName}</strong> has been successfully booked and confirmed.</p>
          
          <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0; font-size: 16px; color: #374151; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px;">📋 Appointment Summary</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; width: 140px;">Date:</td>
                <td style="padding: 8px 0; font-weight: 600;">${day}, ${date}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Slot Time:</td>
                <td style="padding: 8px 0; font-weight: 600;">${slotTime}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Token Number:</td>
                <td style="padding: 8px 0; font-weight: 600; color: #2563eb; font-size: 18px;">#${token}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Reporting Time:</td>
                <td style="padding: 8px 0; font-weight: 600;">${reportingTime}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Reference ID:</td>
                <td style="padding: 8px 0; font-family: monospace; font-size: 12px;">${appointmentId}</td>
              </tr>
              ${notes ? `
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Notes:</td>
                <td style="padding: 8px 0; font-style: italic;">${notes}</td>
              </tr>` : ''}
            </table>
          </div>

          <p style="font-size: 14px; color: #6b7280;">Please arrive at the clinic at least 10 minutes before your reporting time.</p>
          
          <p style="margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
            Best Regards,<br/>
            <strong>Team Schedula</strong>
          </p>
        </div>
      `,
    });
  }

  async sendGoogleWelcomeEmail(to: string): Promise<void> {
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@schedula.com';

    if (!this.transporter) {
      console.warn('[Email] SMTP not configured. Google Welcome to:', to);
      return;
    }

    await this.transporter.sendMail({
      from,
      to,
      subject: "Welcome to Schedula! 🚀",
      html: `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.7; color: #1f2937; max-width: 600px; margin: auto; padding: 20px;">
          <h1 style="color: #212525ff; margin-bottom: 10px;">Signup Successful! 🎉</h1>
          <p style="font-size: 16px;">Hello,</p>
          <p style="font-size: 16px;">Welcome to Schedula! You have successfully signed up using your Google account.</p>
          <p style="font-size: 16px; color: #16a34a; font-weight: 600;">Your account is automatically verified and ready to use.</p>
          <p style="font-size: 16px;">You can now onboard as a Patient or a Doctor to start scheduling.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="display:inline-block; padding:14px 26px; background: #2563eb; color:#ffffff; text-decoration:none; border-radius:10px; font-weight:600;">Go to Dashboard</a>
          </div>
          <p style="margin-top: 25px; font-size: 15px;">Best,<br/><strong>Team Schedula</strong></p>
        </div>
      `,
    });
  }

  async sendAppointmentCancellation(data: {
    to: string;
    patientName: string;
    doctorName: string;
    date: string;
    slotTime: string;
    cancelledBy: 'Patient' | 'Doctor';
  }): Promise<void> {
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@schedula.com';

    if (!this.transporter) {
      console.warn('[Email] SMTP not configured. Cancellation notice for:', data.to);
      return;
    }

    const { patientName, doctorName, date, slotTime, cancelledBy } = data;

    await this.transporter.sendMail({
      from,
      to: data.to,
      subject: '❌ Appointment Cancelled - Schedula',
      html: `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
          <h2 style="color: #dc2626; margin-top: 0;">Appointment Cancelled ❌</h2>
          <p>Hello,</p>
          <p>The appointment between <strong>${patientName}</strong> and <strong>${doctorName}</strong> has been cancelled by the <strong>${cancelledBy}</strong>.</p>
          
          <div style="background-color: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #fee2e2;">
            <h3 style="margin-top: 0; font-size: 16px; color: #991b1b; border-bottom: 1px solid #fee2e2; padding-bottom: 10px;">📅 Cancelled Appointment Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #b91c1c; width: 140px;">Date:</td>
                <td style="padding: 8px 0; font-weight: 600;">${date}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #b91c1c;">Slot Time:</td>
                <td style="padding: 8px 0; font-weight: 600;">${slotTime}</td>
              </tr>
            </table>
          </div>

          <p style="font-size: 14px; color: #6b7280;">If you think this was a mistake, please contact support or attempt to re-book the appointment if the slot is still available.</p>
          
          <p style="margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
            Best Regards,<br/>
            <strong>Team Schedula</strong>
          </p>
        </div>
      `,
    });
  }

  async sendAppointmentReschedule(data: {
    to: string;
    patientName: string;
    doctorName: string;
    oldDate: string;
    oldSlotTime: string;
    newDate: string;
    newDay: string;
    newSlotTime: string;
    newReportingTime: string;
    token: number;
    rescheduledBy: 'Patient' | 'Doctor';
  }): Promise<void> {
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@schedula.com';

    if (!this.transporter) {
      console.warn('[Email] SMTP not configured. Reschedule notice for:', data.to);
      return;
    }

    const { patientName, doctorName, oldDate, oldSlotTime, newDate, newDay, newSlotTime, newReportingTime, token, rescheduledBy } = data;

    await this.transporter.sendMail({
      from,
      to: data.to,
      subject: '🔄 Appointment Rescheduled - Schedula',
      html: `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #2563eb; border-radius: 12px;">
          <h2 style="color: #2563eb; margin-top: 0;">Appointment Rescheduled 🔄</h2>
          <p>Hello,</p>
          <p>The appointment between <strong>${patientName}</strong> and <strong>${doctorName}</strong> has been rescheduled by the <strong>${rescheduledBy}</strong>.</p>
          
          <div style="background-color: #f0f7ff; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #dbeafe;">
            <h3 style="margin-top: 0; font-size: 16px; color: #1e40af; border-bottom: 1px solid #dbeafe; padding-bottom: 10px;">📅 New Appointment Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #1e40af; width: 140px;">New Date:</td>
                <td style="padding: 8px 0; font-weight: 600;">${newDay}, ${newDate}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #1e40af;">New Slot Time:</td>
                <td style="padding: 8px 0; font-weight: 600;">${newSlotTime}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #1e40af;">New Token:</td>
                <td style="padding: 8px 0; font-weight: 600; color: #2563eb; font-size: 18px;">#${token}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #1e40af;">New Reporting Time:</td>
                <td style="padding: 8px 0; font-weight: 600;">${newReportingTime}</td>
              </tr>
            </table>
          </div>

          <div style="font-size: 13px; color: #6b7280; margin-bottom: 20px;">
            <p><strong>Previous Details (Cancelled):</strong> ${oldDate} at ${oldSlotTime}</p>
          </div>

          <p style="font-size: 14px; color: #6b7280;">Please arrive at the clinic at least 10 minutes before your new reporting time.</p>
          
          <p style="margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
            Best Regards,<br/>
            <strong>Team Schedula</strong>
          </p>
        </div>
      `,
    });
  }
}
