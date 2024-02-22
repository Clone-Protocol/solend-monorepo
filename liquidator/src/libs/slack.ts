import axios from "axios";

export const sendMessageToSlack = async (message: string, slackWebhookUrl: string) => {
    console.log(message);
    try {
      await axios.post(
        slackWebhookUrl,
        {
          text: message,
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
      console.log("Message successfully sent to Slack");
    } catch (error) {
      console.error("Error sending message to Slack:", error);
    }
  };