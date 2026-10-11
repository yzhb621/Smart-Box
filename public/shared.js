window.SCB = {
  escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
  async emailConfig() {
    const response = await fetch('/api/email-key', {method:'POST'});
    if (!response.ok) throw new Error('Email configuration unavailable');
    const config = await response.json();
    if (!config.key || !config.serviceId) throw new Error('Email delivery is not configured');
    emailjs.init(config.key);
    return config;
  }
};
