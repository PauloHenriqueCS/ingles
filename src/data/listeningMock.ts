export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  speaker: string;
  textEn: string;
  textPt: string;
}

export interface ListeningQuestion {
  id: number;
  textEn: string;
  options: string[];
  correctIndex: number;
  explanationPt: string;
}

export interface ListeningStory {
  id: string;
  titleEn: string;
  titlePt: string;
  descriptionPt: string;
  level: string;
  durationSeconds: number;
  tags: string[];
  segments: TranscriptSegment[];
  questions: ListeningQuestion[];
}

export const LISTENING_MOCK: ListeningStory = {
  id: 'wrong-voice-note',
  titleEn: 'The Wrong Voice Note',
  titlePt: 'A mensagem de voz errada',
  descriptionPt:
    'Mia quer desabafar com seu amigo Jake sobre seu chefe, mas envia a mensagem para a pessoa errada. O que acontece a seguir vai surpreender você.',
  level: 'B1',
  durationSeconds: 75,
  tags: ['diálogo', 'vida moderna', 'humor', 'trabalho'],
  segments: [
    {
      id: 1, start: 0, end: 8, speaker: 'Narrador',
      textEn: 'Mia is having a terrible day at work. She decides to send a voice note to her best friend Jake to complain about her boss, Mr. Harris.',
      textPt: 'Mia está tendo um dia péssimo no trabalho. Ela decide mandar uma mensagem de voz para seu melhor amigo Jake para reclamar do chefe, Mr. Harris.',
    },
    {
      id: 2, start: 8, end: 19, speaker: 'Mia',
      textEn: "Jake, I can't believe this. Mr. Harris rejected my proposal again! He said it was 'not creative enough'. I spent three weeks on that! He has no idea what he's doing!",
      textPt: "Jake, não acredito. O Mr. Harris rejeitou minha proposta de novo! Disse que não era 'criativa o suficiente'. Passei três semanas naquilo! Ele não faz a menor ideia do que está fazendo!",
    },
    {
      id: 3, start: 19, end: 25, speaker: 'Narrador',
      textEn: 'Mia hits send and feels better. But ten seconds later, her phone buzzes.',
      textPt: 'Mia aperta enviar e se sente aliviada. Mas dez segundos depois, o celular vibra.',
    },
    {
      id: 4, start: 25, end: 34, speaker: 'Jake',
      textEn: 'Hey Mia... I think you sent that to the wrong person. That was in our work group chat. Mr. Harris is in that chat.',
      textPt: 'Ei Mia... acho que você mandou para a pessoa errada. Foi no grupo do trabalho. O Mr. Harris está nesse grupo.',
    },
    {
      id: 5, start: 34, end: 40, speaker: 'Mia',
      textEn: "What?! Oh no. Oh no no no. Please tell me you're joking.",
      textPt: 'O quê?! Não pode ser. Por favor me diz que é uma piada.',
    },
    {
      id: 6, start: 40, end: 50, speaker: 'Jake',
      textEn: "I'm not joking. But his response is actually kind of surprising. He replied with a thumbs up and said: 'I appreciate the honest feedback. Let's talk tomorrow morning.'",
      textPt: "Não é piada. Mas a resposta dele foi surpreendente. Ele respondeu com um positivo e disse: 'Agradeço o feedback honesto. Vamos conversar amanhã de manhã.'",
    },
    {
      id: 7, start: 50, end: 57, speaker: 'Mia',
      textEn: "That's not what I expected. Is he angry? Is this a trap?",
      textPt: 'Não era o que eu esperava. Ele está com raiva? É uma armadilha?',
    },
    {
      id: 8, start: 57, end: 66, speaker: 'Jake',
      textEn: "He doesn't sound angry. Maybe this is your chance to have a real conversation. Sometimes honesty opens doors, even by accident.",
      textPt: 'Não parece com raiva. Talvez seja a sua chance de ter uma conversa de verdade. Às vezes a honestidade abre portas, mesmo que por acidente.',
    },
    {
      id: 9, start: 66, end: 71, speaker: 'Narrador',
      textEn: "The next morning, Mia goes to Mr. Harris's office, nervous but ready.",
      textPt: 'Na manhã seguinte, Mia vai ao escritório do Mr. Harris, nervosa mas determinada.',
    },
    {
      id: 10, start: 71, end: 75, speaker: 'Narrador',
      textEn: 'Mr. Harris admits the proposal was good but needed stronger data. He asks Mia to revise it — together.',
      textPt: 'O Mr. Harris admite que a proposta era boa, mas precisava de dados mais sólidos. Ele pede para Mia revisá-la — juntos.',
    },
  ],
  questions: [
    {
      id: 1,
      textEn: 'What did Mia send by accident?',
      options: [
        'An email with her proposal',
        'A text message to her team',
        'A voice note complaining about her boss',
        'A document with her work schedule',
        'A photo of her workspace',
      ],
      correctIndex: 2,
      explanationPt:
        'Mia enviou uma mensagem de voz (voice note) reclamando do Mr. Harris — sem querer para o lugar errado.',
    },
    {
      id: 2,
      textEn: "Where was Mia's message accidentally sent?",
      options: [
        "Directly to Mr. Harris's personal phone",
        'To the company email list',
        'To a work group chat that included Mr. Harris',
        'To all of her personal contacts',
        'To a public social media profile',
      ],
      correctIndex: 2,
      explanationPt:
        'A mensagem foi para o grupo do trabalho (work group chat), onde o Mr. Harris também estava.',
    },
    {
      id: 3,
      textEn: 'How did Mr. Harris respond to the voice note?',
      options: [
        'He called HR immediately',
        'He ignored the message completely',
        'He sent an angry reply to the whole team',
        'He replied positively and asked to talk the next morning',
        'He fired Mia by text message',
      ],
      correctIndex: 3,
      explanationPt:
        'Mr. Harris respondeu de forma positiva, agradeceu o feedback honesto e pediu uma conversa na manhã seguinte.',
    },
    {
      id: 4,
      textEn: "What was Jake's perspective on what happened?",
      options: [
        'He thought Mia should deny sending the message',
        'He believed Mr. Harris was setting a trap for Mia',
        'He suggested Mia should quit her job immediately',
        'He thought honesty could open doors, even by accident',
        'He said Mia should apologize and forget the proposal',
      ],
      correctIndex: 3,
      explanationPt:
        'Jake disse que às vezes a honestidade abre portas, mesmo que por acidente — e que era uma chance para uma conversa real.',
    },
    {
      id: 5,
      textEn: 'What happened in the morning meeting?',
      options: [
        'Mr. Harris rejected the proposal one final time',
        'Mia was transferred to a different department',
        'The project was cancelled entirely',
        'Mr. Harris said the proposal needed more data and they revised it together',
        'Mia decided to quit after the meeting',
      ],
      correctIndex: 3,
      explanationPt:
        'Mr. Harris reconheceu que a proposta era boa, mas precisava de dados mais sólidos. Eles decidiram revisá-la juntos.',
    },
  ],
};
