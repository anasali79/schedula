import { Injectable } from '@nestjs/common';
const SibApiV3Sdk = require('sib-api-v3-sdk');

@Injectable()
export class EmailService {
  private apiInstance: any;
  private primaryColor = '#2563eb';
  private accentColor = '#3b82f6';
  private textColor = '#1f2937';
  private lightTextColor = '#6b7280';
  private bgColor = '#f9fafb';

  constructor() {
    const apiKey = process.env.BREVO_API_KEY || process.env.EMAIL_PASS?.trim();
    if (apiKey) {
      console.log('[EmailService] Initializing Brevo (sib-api-v3-sdk)');
      const defaultClient = SibApiV3Sdk.ApiClient.instance;
      const apiKeyInstance = defaultClient.authentications['api-key'];
      apiKeyInstance.apiKey = apiKey;
      this.apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    } else {
      console.warn('[EmailService] Brevo API key missing (BREVO_API_KEY or EMAIL_PASS).');
    }
  }

  private wrapLayout(title: string, content: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: ${this.bgColor}; color: ${this.textColor}; -webkit-font-smoothing: antialiased;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout: fixed;">
          <tr>
            <td align="center" style="padding: 40px 10px;">
              <table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);">
                <!-- Header -->
                <tr>
                  <td align="center" style="padding: 40px 0; background: linear-gradient(135deg, ${this.primaryColor}, ${this.accentColor});">
                    <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 800; letter-spacing: -0.05em;">Schedula</h1>
                    <p style="color: rgba(255, 255, 255, 0.8); margin-top: 8px; font-size: 14px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em;">Health Care. Simplified.</p>
                  </td>
                </tr>
                <!-- Content -->
                <tr>
                  <td style="padding: 40px 50px;">
                    ${content}
                  </td>
                </tr>
                <!-- Footer -->
                <tr>
                  <td style="padding: 30px 50px; background-color: #f3f4f6; border-top: 1px solid #e5e7eb; text-align: center;">
                    <p style="margin: 0; font-size: 14px; color: ${this.lightTextColor};">&copy; ${new Date().getFullYear()} Schedula. All rights reserved.</p>
                    <div style="margin-top: 15px;">
                       <p style="margin: 0; font-size: 12px; color: #9ca3af;">You're receiving this because you're a valued member of Schedula.</p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
  }

  private async sendBrevoEmail(to: string, subject: string, htmlContent: string): Promise<void> {
    if (!this.apiInstance) return;

    const fromEmail = process.env.EMAIL_USER || 'noreply@schedula.com';
    const fromName = 'Schedula';

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    sendSmtpEmail.sender = { name: fromName, email: fromEmail };
    sendSmtpEmail.to = [{ email: to }];

    try {
      await this.apiInstance.sendTransacEmail(sendSmtpEmail);
      console.log(`[Email] Email sent via Brevo to: ${to}`);
    } catch (error: any) {
      console.error(`[Email] Brevo Error for ${to}:`, error.message);
    }
  }

  async sendWelcomeVerificationEmail(to: string, verificationLink: string): Promise<void> {
    const content = `
      <h2 style="margin-top: 0; color: #111827; font-size: 24px; font-weight: 700;">Welcome to Schedula 👋</h2>
      <p style="font-size: 16px; color: #4b5563; line-height: 1.6;">We're thrilled to have you here! Your journey to a smoother healthcare experience starts with just one small step.</p>
      <div style="margin: 32px 0; padding: 24px; background-color: #eff6ff; border-radius: 12px; border: 1px solid #dbeafe; text-align: center;">
        <h3 style="margin-top: 0; color: #1e40af; font-size: 18px;">Verify Your Email</h3>
        <p style="color: #60a5fa; font-size: 14px; margin-bottom: 24px;">Please click the button below to secure your account.</p>
        <a href="${verificationLink}" style="display: inline-block; padding: 14px 32px; background-color: ${this.primaryColor}; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">Confirm Identity</a>
      </div>
      <p style="font-size: 14px; color: #9ca3af; text-align: center;">If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="font-size: 12px; color: #3b82f6; word-break: break-all; text-align: center; margin-top: 8px;">${verificationLink}</p>
    `;

    await this.sendBrevoEmail(to, "Verify your email - Schedula", this.wrapLayout('Welcome to Schedula', content));
  }

  async sendMail(options: { to: string; subject: string; text?: string; html?: string }): Promise<void> {
    const html = options.html ? this.wrapLayout(options.subject, options.html) : (options.text || '');
    await this.sendBrevoEmail(options.to, options.subject, html);
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
    appointmentId?: string;
    notes?: string;
  }): Promise<void> {
    const { patientName, doctorName, date, day, slotTime, token, reportingTime, notes } = data;

    const content = `
      <h2 style="margin-top: 0; color: #111827; font-size: 24px; font-weight: 700;">Appointment Confirmed! ✅</h2>
      <p style="font-size: 16px; color: #4b5563; margin-bottom: 24px;">Hi <strong>${patientName}</strong>, your visit with <strong>${doctorName}</strong> is confirmed. Here's your appointment card:</p>
      
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; margin-bottom: 24px;">
        <table width="100%" border="0" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-bottom: 24px;">
              <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.1em;">Doctor</p>
              <p style="margin: 4px 0 0; font-size: 18px; color: #1e293b; font-weight: 700;">${doctorName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom: 24px;">
              <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.1em;">Date & Time</p>
              <p style="margin: 4px 0 0; font-size: 18px; color: #1e293b; font-weight: 600;">${day}, ${date} @ ${slotTime}</p>
            </td>
          </tr>
          <tr>
            <td>
              <table width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="55%">
                    <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.1em;">Reporting Time</p>
                    <p style="margin: 4px 0 0; font-size: 18px; color: #1e293b; font-weight: 700;">${reportingTime}</p>
                  </td>
                  <td width="45%" style="text-align: right;">
                    <div style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 10px 20px; border-radius: 12px;">
                      <p style="margin: 0; font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; opacity: 0.9;">Token</p>
                      <p style="margin: 0; font-size: 24px; font-weight: 800;">#${token}</p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
      
      ${notes ? `
      <div style="margin-bottom: 24px;">
        <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.1em;">Notes</p>
        <p style="margin: 4px 0 0; font-size: 14px; color: #4b5563; line-height: 1.5;">${notes}</p>
      </div>` : ''}

      <div style="background-color: #fffbeb; border: 1px solid #fef3c7; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
        <p style="margin: 0; font-size: 14px; color: #92400e;">
          <strong>Important:</strong> Please arrive at the reporting time to confirm your presence at the clinic.
        </p>
      </div>

      <div style="text-align: center; margin-top: 32px;">
        <a href="#" style="background-color: #f3f4f6; color: #374151; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block; border: 1px solid #e5e7eb;">View All Appointments</a>
      </div>
    `;

    await this.sendBrevoEmail(data.to, 'Appointment Confirmed - Schedula', this.wrapLayout('Appointment Confirmation', content));
  }

  async sendGoogleWelcomeEmail(to: string): Promise<void> {
    const content = `
      <h2 style="margin-top: 0; color: #111827; font-size: 24px; font-weight: 700;">Google Signup Successful 🚀</h2>
      <p style="font-size: 16px; color: #4b5563; line-height: 1.6;">Welcome to the Schedula family! We've successfully linked your Google account.</p>
      <p style="font-size: 16px; color: #4b5563; line-height: 1.6;">You can now book appointments, track your medical history, and manage your health with ease.</p>
      <div style="margin-top: 32px; text-align: center;">
        <a href="#" style="background-color: ${this.primaryColor}; color: #ffffff; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 16px;">Go to Dashboard</a>
      </div>
    `;

    await this.sendBrevoEmail(to, "Welcome to Schedula! 🚀", this.wrapLayout('Welcome to Schedula', content));
  }

  async sendAppointmentCancellation(data: {
    to: string;
    patientName: string;
    doctorName: string;
    date: string;
    slotTime: string;
    cancelledBy: 'Patient' | 'Doctor';
  }): Promise<void> {
    const { patientName, doctorName, date, slotTime, cancelledBy } = data;

    const content = `
      <h2 style="margin-top: 0; color: #b91c1c; font-size: 24px; font-weight: 700;">Appointment Cancelled ❌</h2>
      <p style="font-size: 16px; color: #4b5563; line-height: 1.6;">Hi <strong>${patientName}</strong>, the appointment scheduled with <strong>${doctorName}</strong> has been cancelled by the <strong>${cancelledBy.toLowerCase()}</strong>.</p>
      
      <div style="margin: 24px 0; padding: 24px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
        <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.1em;">Cancelled Appointment Details</p>
        <p style="margin: 8px 0 0; font-size: 15px; color: #1e293b;"><strong>Date:</strong> ${date}</p>
        <p style="margin: 4px 0 0; font-size: 15px; color: #1e293b;"><strong>Time:</strong> ${slotTime}</p>
      </div>

      <div style="margin: 32px 0; padding: 20px; background-color: #fef2f2; border-radius: 12px; border: 1px solid #fecaca; text-align: center;">
        <p style="margin: 0; color: #991b1b; font-size: 15px; font-weight: 500;">Need to reschedule? You can book a new slot anytime through our app.</p>
      </div>

      <div style="text-align: center;">
        <a href="#" style="background-color: ${this.primaryColor}; color: #ffffff; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">Browse Doctors</a>
      </div>
    `;

    await this.sendBrevoEmail(data.to, 'Appointment Cancelled - Schedula', this.wrapLayout('Appointment Cancellation', content));
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
    const { patientName, doctorName, oldDate, oldSlotTime, newDate, newDay, newSlotTime, newReportingTime, token } = data;

    const content = `
      <h2 style="margin-top: 0; color: #1e40af; font-size: 24px; font-weight: 700;">Appointment Rescheduled 🔄</h2>
      <p style="font-size: 16px; color: #4b5563; line-height: 1.6;">Hi <strong>${patientName}</strong>, your visit with <strong>${doctorName}</strong> has been rescheduled. Here is your updated appointment card:</p>
      
      <div style="margin: 24px 0; background-color: #f0f7ff; border-radius: 20px; overflow: hidden; border: 1px solid #dbeafe;">
        <div style="padding: 20px; background-color: #dbeafe;">
           <p style="margin: 0; font-size: 11px; text-transform: uppercase; color: #1e40af; font-weight: 800; letter-spacing: 0.1em;">Previous Slot</p>
           <p style="margin: 4px 0 0; font-size: 14px; color: #1e40af; opacity: 0.8;">${oldDate} @ ${oldSlotTime}</p>
        </div>
        <div style="padding: 32px;">
          <table width="100%" border="0" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-bottom: 24px;">
                <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.1em;">New Date & Time</p>
                <p style="margin: 4px 0 0; font-size: 18px; color: #1e293b; font-weight: 700;">${newDay}, ${newDate} @ ${newSlotTime}</p>
              </td>
            </tr>
            <tr>
              <td>
                <table width="100%" border="0" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="55%">
                      <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.1em;">New Reporting Time</p>
                      <p style="margin: 4px 0 0; font-size: 18px; color: #1e293b; font-weight: 700;">${newReportingTime}</p>
                    </td>
                    <td width="45%" style="text-align: right;">
                      <div style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 10px 20px; border-radius: 12px;">
                        <p style="margin: 0; font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; opacity: 0.9;">Token</p>
                        <p style="margin: 0; font-size: 24px; font-weight: 800;">#${token}</p>
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </div>
      </div>

      <p style="font-size: 14px; color: #6b7280; font-style: italic; text-align: center;">Please update your schedule. We look forward to seeing you at the clinic!</p>
      
      <div style="margin-top: 32px; text-align: center;">
        <a href="#" style="background-color: ${this.primaryColor}; color: #ffffff; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 16px;">View updated details</a>
      </div>
    `;

    await this.sendBrevoEmail(data.to, 'Appointment Rescheduled - Schedula', this.wrapLayout('Appointment Rescheduled', content));
  }

  async sendInformativeEmail(to: string, subject: string, title: string, content: string): Promise<void> {
    await this.sendBrevoEmail(to, subject, this.wrapLayout(title, content));
  }

  async sendAppointmentMovedToQueue(data: {
    to: string;
    patientName: string;
    doctorName: string;
    date: string;
    oldSlotTime: string;
    reason: string;
  }): Promise<void> {
    const { patientName, doctorName, date, oldSlotTime, reason } = data;

    const content = `
      <h2 style="margin-top: 0; color: #9a3412; font-size: 24px; font-weight: 700;">Action Required: Appointment Update ⏳</h2>
      <p style="font-size: 16px; color: #4b5563; line-height: 1.6;">Hi <strong>${patientName}</strong>, due to a change in <strong>${doctorName}'s</strong> schedule, we are unable to fulfill your original appointment on <strong>${date} at ${oldSlotTime}</strong>.</p>
      
      <div style="margin: 24px 0; padding: 24px; background-color: #fff7ed; border: 1px solid #ffedd5; border-radius: 12px;">
        <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #9a3412; font-weight: 700; letter-spacing: 0.1em;">Status Update</p>
        <p style="margin: 8px 0 0; font-size: 15px; color: #7c2d12; font-weight: 600;">Moved to Priority Reschedule Queue</p>
        <p style="margin: 12px 0 0; font-size: 14px; color: #9a3412; line-height: 1.4;"><strong>Reason:</strong> ${reason}</p>
      </div>

      <p style="font-size: 15px; color: #4b5563; line-height: 1.6;"><strong>What happens next?</strong> Our team will contact you shortly to find the next best available slot that works for you. You are at the top of our rescheduling list.</p>

      <div style="margin-top: 32px; text-align: center;">
        <a href="#" style="background-color: #ea580c; color: #ffffff; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px -1px rgba(234, 88, 12, 0.2);">Check Availability</a>
      </div>
    `;

    await this.sendBrevoEmail(data.to, 'Immediate Action: Appointment Schedule Change - Schedula', this.wrapLayout('Schedule Update', content));
  }
}